import { DurableObject } from 'cloudflare:workers';
import {
  canTransitionLaunch,
  createLaunchSnapshot,
  startLaunchRevision,
  transitionLaunch,
} from '../lib/launch/state-machine';
import {
  classifyLaunchFailure,
  decideLaunchRecovery,
  recordLaunchRecovery,
} from '../lib/launch/recovery-policy';
import { parseGeneratedArtifact } from '../lib/launch/artifact';
import { createSafeBaselineHtml } from '../lib/launch/safe-baseline';
import type {
  LaunchArtifact,
  LaunchEvent,
  LaunchEventsResponse,
  LaunchRequest,
  LaunchRuntimeReport,
  LaunchSnapshot,
} from '../lib/launch/types';
import type { CodeSandbox } from './code-sandbox';
import {
  buildCandidateRuntime,
  getCandidateSandboxId,
} from './candidate-runtime';

const SNAPSHOT_KEY = 'launch:snapshot';
const BASELINE_HTML_KEY = 'launch:baseline-html';
const EVENT_PREFIX = 'launch:event:';
const IDEMPOTENCY_PREFIX = 'launch:idempotency:';
const ARTIFACT_PREFIX = 'launch:artifact:';
const PENDING_REQUESTS_KEY = 'launch:pending-requests';
const PENDING_REQUEST_PREFIX = 'launch:pending-request:';
const LEASE_KEY = 'launch:lease';
const LEASE_DURATION_MS = 45_000;
const LEASE_HEARTBEAT_MS = 15_000;
const WATCHDOG_ALARM_MS = 60_000;
const ARTIFACT_CHUNK_BYTES = 96_000;
const BUILDER_REQUEST_TIMEOUT_MS = 6 * 60_000;

interface LaunchLease {
  owner: string;
  expiresAt: number;
}

interface ArtifactChunks {
  count: number;
  bytes: number;
}

interface GeneratedArtifactResponse {
  generatedCode: string;
  model?: string;
  packagesToInstall?: string[];
  explanation?: string;
}

export interface LaunchRunEnv {
  CODE_SANDBOX: DurableObjectNamespace<CodeSandbox>;
  CODE_MARKET?: DurableObjectNamespace;
  CLOUDFLARE_SANDBOX_PUBLIC_URL?: string;
  LAUNCH_BUILDER_ORIGIN?: string;
  BUILDER_INTERNAL_SECRET?: string;
}

export interface StartLaunchInput {
  runId: string;
  previewUrl: string;
  request: LaunchRequest;
}

function eventKey(sequence: number): string {
  return `${EVENT_PREFIX}${String(sequence).padStart(12, '0')}`;
}

function cloneRequest(request: Request, url: URL): Request {
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: request.redirect,
  });
}

function boundedRecoveryHistory(
  history: LaunchSnapshot['recoveryHistory'],
): LaunchSnapshot['recoveryHistory'] {
  return Object.fromEntries(
    Object.entries(history)
      .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20),
  );
}

// ─── Ariadne's Thread [AT-0025] ─────────────────────
// What: Persist one resumable launch run per Durable Object and serve its stable last-known-good preview
// Why:  Browser state and a single Next.js process cannot guarantee recovery after reloads, crashes, or duplicate requests
// Date: 2026-09-30
// Related: [AT-0019] shared→lib/launch/types.ts:LaunchSnapshot, [AT-0020] shared→lib/launch/state-machine.ts:transitionLaunch, [AT-0008] infra→cloudflare/code-sandbox.ts:CodeSandbox
// ─────────────────────────────────────────────────────
export class LaunchRun extends DurableObject {
  readonly #ctx: DurableObjectState;
  readonly #env: LaunchRunEnv;

  constructor(ctx: DurableObjectState, env: LaunchRunEnv) {
    super(ctx, env);
    this.#ctx = ctx;
    this.#env = env;
  }

  async start(input: StartLaunchInput): Promise<LaunchSnapshot> {
    const received = createLaunchSnapshot(input.runId, input.request, input.previewUrl);
    const baseline = transitionLaunch(received, 'BASELINE_RUNNING', {
      availability: 'running',
      fidelity: 'baseline',
      statusMessage: 'A safe interactive preview is running while the full product is prepared.',
    });
    const baselineHtml = createSafeBaselineHtml(input.request.prompt, input.runId);

    const outcome = await this.#ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<LaunchSnapshot>(SNAPSHOT_KEY);
      if (existing) {
        const acceptedRevision = await transaction.get<number>(
          `${IDEMPOTENCY_PREFIX}${input.request.idempotencyKey}`,
        );
        if (acceptedRevision === undefined) {
          throw new Error(`Launch run ${input.runId} already exists with another idempotency key`);
        }
        return { snapshot: existing, created: false, acceptedRevision };
      }
      await transaction.put(SNAPSHOT_KEY, baseline);
      await transaction.put(BASELINE_HTML_KEY, baselineHtml);
      await transaction.put(`${IDEMPOTENCY_PREFIX}${input.request.idempotencyKey}`, 0);
      await transaction.put(eventKey(baseline.sequence), this.createEvent(
        baseline,
        'baseline.published',
        baseline.statusMessage,
      ));
      return { snapshot: baseline, created: true, acceptedRevision: 0 };
    });
    if (!outcome.created) {
      console.log('[LaunchRun] Returning idempotent start result', {
        runId: outcome.snapshot.runId,
        revision: outcome.acceptedRevision,
        idempotencyKey: input.request.idempotencyKey,
      });
      return outcome.snapshot;
    }

    console.log('[LaunchRun] Safe baseline published', {
      runId: input.runId,
      state: baseline.state,
      previewUrl: baseline.previewUrl,
      sequence: baseline.sequence,
    });
    await this.scheduleResume(1);
    this.#ctx.waitUntil(this.runWithLease('start'));
    return outcome.snapshot;
  }

  async submitRevision(request: LaunchRequest): Promise<LaunchSnapshot> {
    // ─── Ariadne's Thread [AT-0055] ─────────────────────
    // What: Persist edits submitted while another candidate is still being validated
    // Why:  User input must not fail or race the active revision; it should resume in order after promotion
    // Date: 2026-09-30
    // Related: [AT-0020] shared→lib/launch/state-machine.ts:startLaunchRevision, [AT-0035] cloudflare/launch-run.ts:reportRuntime
    // ─────────────────────────────────────────────────────
    const outcome = await this.#ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<LaunchSnapshot>(SNAPSHOT_KEY);
      if (!current) throw new Error('Launch run has not been initialized');
      const acceptedRevision = await transaction.get<number>(
        `${IDEMPOTENCY_PREFIX}${request.idempotencyKey}`,
      );
      if (acceptedRevision !== undefined) {
        console.log('[LaunchRun] Returning idempotent revision result', {
          runId: current.runId,
          revision: acceptedRevision,
          idempotencyKey: request.idempotencyKey,
        });
        return { snapshot: current, shouldStart: false };
      }
      if (current.state === 'CANCELLED') {
        throw new Error('Cancelled launch runs cannot accept a new revision');
      }

      const canStartImmediately = current.state === 'RUNNING_EXACT' || current.state === 'RUNNING_DEGRADED';
      if (!canStartImmediately) {
        const pending = (await transaction.get<string[]>(PENDING_REQUESTS_KEY)) ?? [];
        pending.push(request.idempotencyKey);
        await transaction.put(PENDING_REQUESTS_KEY, pending);
        await transaction.put(`${PENDING_REQUEST_PREFIX}${request.idempotencyKey}`, request);
        await transaction.put(
          `${IDEMPOTENCY_PREFIX}${request.idempotencyKey}`,
          current.revision + pending.length,
        );
        console.log('[LaunchRun] Revision persisted in pending queue', {
          runId: current.runId,
          activeRevision: current.revision,
          pendingCount: pending.length,
          idempotencyKey: request.idempotencyKey,
        });
        return {
          snapshot: {
            ...current,
            statusMessage: `Queued ${pending.length} additional revision${pending.length === 1 ? '' : 's'} behind the active candidate.`,
          },
          shouldStart: false,
        };
      }

      const next = startLaunchRevision(current, request);
      await transaction.put(SNAPSHOT_KEY, next);
      await transaction.put(`${IDEMPOTENCY_PREFIX}${request.idempotencyKey}`, next.revision);
      await transaction.put(eventKey(next.sequence), this.createEvent(
        next,
        'revision.queued',
        next.statusMessage,
      ));
      return { snapshot: next, shouldStart: true };
    });
    if (outcome.shouldStart) {
      await this.scheduleResume(1);
      this.#ctx.waitUntil(this.runWithLease('revision'));
    }
    return outcome.snapshot;
  }

  async getSnapshot(): Promise<LaunchSnapshot | null> {
    return (await this.#ctx.storage.get<LaunchSnapshot>(SNAPSHOT_KEY)) ?? null;
  }

  async getEvents(afterSequence = 0): Promise<LaunchEventsResponse> {
    const entries = await this.#ctx.storage.list<LaunchEvent>({
      prefix: EVENT_PREFIX,
      startAfter: eventKey(afterSequence),
    });
    const events = [...entries.values()].sort((left, right) => left.sequence - right.sequence);
    const snapshot = await this.getSnapshot();
    return {
      events,
      latestSequence: snapshot?.sequence ?? afterSequence,
    };
  }

  async reportRuntime(report: LaunchRuntimeReport): Promise<LaunchSnapshot> {
    let current = await this.requireSnapshot();
    console.log('[LaunchRun] Runtime report received', {
      runId: report.runId,
      revision: report.revision,
      status: report.status,
      idempotencyKey: report.idempotencyKey,
    });
    if (report.runId !== current.runId || report.revision !== current.revision) {
      console.warn('[LaunchRun] Ignoring stale runtime report', {
        expectedRunId: current.runId,
        expectedRevision: current.revision,
        reportRunId: report.runId,
        reportRevision: report.revision,
      });
      return current;
    }
    const initialValidProbeTokens = [
      current.state === 'RUNTIME_PROBING' ? current.candidateProbeToken : undefined,
      current.activeProbeToken,
    ].filter((token): token is string => Boolean(token));
    if (initialValidProbeTokens.length > 0 && !initialValidProbeTokens.includes(report.probeToken ?? '')) {
      console.warn('[LaunchRun] Rejecting runtime report with an invalid probe token', {
        runId: current.runId,
        revision: current.revision,
        reportProbeToken: report.probeToken,
      });
      return current;
    }
    const reportKey = `${IDEMPOTENCY_PREFIX}runtime:${report.idempotencyKey}`;
    const accepted = await this.#ctx.storage.transaction(async (transaction) => {
      if (await transaction.get<boolean>(reportKey)) return false;
      await transaction.put(reportKey, true);
      return true;
    });
    if (!accepted) return current;
    current = await this.requireSnapshot();
    if (report.runId !== current.runId || report.revision !== current.revision) {
      console.warn('[LaunchRun] Runtime report became stale while it was being accepted', {
        reportRunId: report.runId,
        reportRevision: report.revision,
        currentRunId: current.runId,
        currentRevision: current.revision,
        currentState: current.state,
      });
      return current;
    }

    if (report.status === 'boot') {
      return current;
    }
    const runtimeValidationActive = current.state === 'RUNTIME_PROBING'
      && (!current.candidateProbeToken || report.probeToken === current.candidateProbeToken);
    const promotedRuntimeActive = Boolean(
      current.activeSandboxId
      && current.activeProbeToken
      && report.probeToken === current.activeProbeToken,
    );
    if (!runtimeValidationActive && !promotedRuntimeActive) {
      return current;
    }
    const expectedProbeToken = runtimeValidationActive
      ? current.candidateProbeToken
      : current.activeProbeToken;
    if (expectedProbeToken && report.probeToken !== expectedProbeToken) {
      console.warn('[LaunchRun] Ignoring runtime report from a superseded candidate probe', {
        runId: current.runId,
        revision: current.revision,
        reportProbeToken: report.probeToken,
        expectedProbeToken,
      });
      return current;
    }

    // ─── Ariadne's Thread [AT-0035] ─────────────────────
    // What: Promote only browser-proven candidates and preserve the former active sandbox for rollback
    // Why:  HTTP and build success cannot detect blank DOM output or client-side exceptions
    // Date: 2026-09-30
    // Related: [AT-0031] infra→cloudflare/candidate-runtime.ts:buildCandidateRuntime, [AT-0022] shared→lib/launch/safe-baseline.ts:createRuntimeProbeScript
    // ─────────────────────────────────────────────────────
    if (report.status === 'ready' && runtimeValidationActive && current.candidateSandboxId) {
      const targetState = current.fidelity === 'exact' ? 'RUNNING_EXACT' : 'RUNNING_DEGRADED';
      const promoted = transitionLaunch(current, targetState, {
        availability: 'running',
        activeSandboxId: current.candidateSandboxId,
        activeProbeToken: current.candidateProbeToken,
        previousSandboxId: current.activeSandboxId,
        previousProbeToken: current.activeProbeToken,
        candidateUrl: undefined,
        candidateSandboxId: undefined,
        candidateProbeToken: undefined,
        checkpoint: undefined,
        statusMessage: targetState === 'RUNNING_EXACT'
          ? 'The product is running and passed build, server, and browser checks.'
          : 'A simplified product is running and passed build, server, and browser checks.',
      });
      await this.persistEvent(promoted, 'candidate.promoted', promoted.statusMessage);
      await this.#ctx.storage.deleteAlarm();
      return this.activateNextPending(promoted);
    }
    if (report.status === 'ready') return current;

    const message = report.message || (
      report.status === 'blank-root'
        ? 'The candidate rendered a blank root.'
        : 'The candidate raised a browser runtime error.'
    );
    const classificationMessage = report.status === 'error'
      ? `Runtime error: ${message}`
      : report.status === 'blank-root'
        ? `Blank root: ${message}`
        : message;
    const failure = classifyLaunchFailure(classificationMessage, current.state, current.revision, {
      diagnostics: report.stack,
    });
    const repairing = transitionLaunch(current, 'REPAIRING', {
      lastFailure: failure,
      activeSandboxId: promotedRuntimeActive
        ? current.previousSandboxId
        : current.activeSandboxId,
      activeProbeToken: promotedRuntimeActive
        ? current.previousProbeToken
        : current.activeProbeToken,
      statusMessage: `Runtime validation failed. Recovery is preparing the next strategy: ${message}`,
    });
    await this.persistEvent(repairing, 'candidate.runtime-failed', repairing.statusMessage);
    await this.scheduleResume(1);
    this.#ctx.waitUntil(this.runWithLease('runtime-report'));
    return repairing;
  }

  async cancel(): Promise<LaunchSnapshot> {
    const current = await this.requireSnapshot();
    const cancelled = transitionLaunch(current, 'CANCELLED', {
      statusMessage: 'Launch cancelled by the user.',
    });
    await this.persistEvent(cancelled, 'launch.cancelled', cancelled.statusMessage);
    await this.#ctx.storage.deleteAlarm();
    const pending = (await this.#ctx.storage.get<string[]>(PENDING_REQUESTS_KEY)) ?? [];
    await Promise.all(
      pending.map((idempotencyKey) => this.#ctx.storage.delete(`${PENDING_REQUEST_PREFIX}${idempotencyKey}`)),
    );
    await this.#ctx.storage.delete(PENDING_REQUESTS_KEY);
    return cancelled;
  }

  async alarm(): Promise<void> {
    console.log('[LaunchRun] Resume alarm fired');
    await this.runWithLease('alarm');
  }

  override async fetch(request: Request): Promise<Response> {
    const snapshot = await this.getSnapshot();
    if (!snapshot) return new Response('Launch run not found', { status: 404 });

    const url = new URL(request.url);
    const candidateMatch = /^\/candidate\/(\d+)(\/.*)?$/.exec(url.pathname);
    const isStablePreview = url.pathname === '/preview' || url.pathname.startsWith('/preview/');
    if (!candidateMatch && !isStablePreview) {
      return new Response('Launch preview route not found', { status: 404 });
    }

    const sandboxId = candidateMatch
      ? Number(candidateMatch[1]) === snapshot.revision
        ? snapshot.candidateSandboxId
        : undefined
      : snapshot.activeSandboxId;

    if (sandboxId) {
      const suffix = candidateMatch
        ? candidateMatch[2] || '/'
        : url.pathname.slice('/preview'.length) || '/';
      // ─── Ariadne's Thread [AT-0060] ─────────────────────
      // What: Fall back to safe HTML and enqueue repair when an active container stops answering
      // Why:  Inactivity, eviction, or process death must never turn the stable preview URL into a 503
      // Date: 2026-09-30
      // Related: [AT-0032] cloudflare/code-sandbox.ts:inspectSession, [AT-0035] cloudflare/launch-run.ts:reportRuntime
      // ─────────────────────────────────────────────────────
      if (!candidateMatch && suffix === '/') {
        try {
          const health = await this.#env.CODE_SANDBOX.getByName(sandboxId).inspectSession(sandboxId);
          if (!health.containerRunning || !health.previewReady) {
            console.error('[LaunchRun] Active preview health check failed; serving safe baseline', {
              runId: snapshot.runId,
              revision: snapshot.revision,
              sandboxId,
              containerRunning: health.containerRunning,
              previewReady: health.previewReady,
              logBytes: health.log.length,
            });
            this.#ctx.waitUntil(this.reportRuntime({
              runId: snapshot.runId,
              revision: snapshot.revision,
              status: 'error',
              message: health.log || 'Active sandbox preview is not running.',
              probeToken: snapshot.activeProbeToken,
              idempotencyKey: `${snapshot.runId}:${snapshot.revision}:health:${sandboxId}:${snapshot.sequence}`,
            }));
            return this.safeBaselineResponse(snapshot);
          }
        } catch (error) {
          console.error('[LaunchRun] Active preview health request failed; serving safe baseline', {
            runId: snapshot.runId,
            revision: snapshot.revision,
            sandboxId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.#ctx.waitUntil(this.reportRuntime({
            runId: snapshot.runId,
            revision: snapshot.revision,
            status: 'error',
            message: error instanceof Error ? error.message : 'Active sandbox health request failed.',
            probeToken: snapshot.activeProbeToken,
            idempotencyKey: `${snapshot.runId}:${snapshot.revision}:health-request:${sandboxId}:${snapshot.sequence}`,
          }));
          return this.safeBaselineResponse(snapshot);
        }
      }
      const target = new URL(request.url);
      target.protocol = 'http:';
      target.host = 'container';
      target.pathname = `/previews/${sandboxId}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
      console.log('[LaunchRun] Proxying preview request', {
        runId: snapshot.runId,
        revision: snapshot.revision,
        sandboxId,
        path: suffix,
        candidate: Boolean(candidateMatch),
      });
      return this.#env.CODE_SANDBOX.getByName(sandboxId).fetch(cloneRequest(request, target));
    }

    if (!candidateMatch && (url.pathname === '/preview' || url.pathname === '/preview/')) {
      return this.safeBaselineResponse(snapshot);
    }

    return new Response('Preview asset not found', { status: 404 });
  }

  protected async advance(): Promise<void> {
    const snapshot = await this.getSnapshot();
    if (!snapshot || snapshot.state === 'CANCELLED') return;
    console.log('[LaunchRun] Advancing durable launch state', {
      runId: snapshot.runId,
      revision: snapshot.revision,
      state: snapshot.state,
      checkpoint: snapshot.checkpoint?.id,
    });

    if (snapshot.state === 'BASELINE_RUNNING') {
      const generating = {
        ...startLaunchRevision(snapshot, snapshot.request),
        fidelity: 'exact' as const,
      };
      await this.persistEvent(generating, 'generation.started', generating.statusMessage);
      await this.scheduleResume(1);
      return;
    }

    if (snapshot.state === 'GENERATING') {
      if (snapshot.checkpoint?.phase === 'GENERATING' && snapshot.checkpoint.status === 'started') {
        let checkpointedArtifact: LaunchArtifact | null = null;
        try {
          checkpointedArtifact = await this.getArtifact(snapshot.revision);
        } catch (error) {
          console.error('[LaunchRun] Checkpointed artifact is incomplete; regenerating safely', {
            runId: snapshot.runId,
            revision: snapshot.revision,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.#ctx.storage.delete(`${ARTIFACT_PREFIX}${snapshot.revision}:meta`);
        }
        if (checkpointedArtifact) {
          const resumed = transitionLaunch(snapshot, 'PREPARING_CANDIDATE', {
            checkpoint: {
              ...snapshot.checkpoint,
              status: 'completed',
              completedAt: new Date().toISOString(),
            },
            statusMessage: `Resumed ${checkpointedArtifact.files.length} checkpointed files without repeating model generation.`,
          });
          await this.persistEvent(resumed, 'generation.resumed-from-checkpoint', resumed.statusMessage);
          await this.scheduleResume(1);
          return;
        }
      }
      const checkpoint = {
        id: `${snapshot.runId}:${snapshot.revision}:generate`,
        phase: 'GENERATING' as const,
        status: 'started' as const,
        attempt: (snapshot.checkpoint?.phase === 'GENERATING' ? snapshot.checkpoint.attempt : 0) + 1,
        idempotencyKey: `${snapshot.runId}:${snapshot.revision}:generate`,
        startedAt: new Date().toISOString(),
      };
      const generating = transitionLaunch(snapshot, 'GENERATING', {
        checkpoint,
        statusMessage: 'The model is generating a complete candidate artifact.',
      });
      await this.persistEvent(generating, 'generation.in-progress', generating.statusMessage);
      await this.scheduleResume(WATCHDOG_ALARM_MS);

      const artifact = await this.generateArtifact(generating);
      const latestAfterGeneration = await this.requireSnapshot();
      if (
        latestAfterGeneration.state === 'CANCELLED'
        || latestAfterGeneration.checkpoint?.id !== checkpoint.id
      ) {
        console.warn('[LaunchRun] Discarding stale generation result', {
          runId: snapshot.runId,
          revision: snapshot.revision,
          latestState: latestAfterGeneration.state,
          latestCheckpoint: latestAfterGeneration.checkpoint?.id,
          completedCheckpoint: checkpoint.id,
        });
        return;
      }
      await this.putArtifact(artifact);
      const preparing = transitionLaunch(latestAfterGeneration, 'PREPARING_CANDIDATE', {
        checkpoint: {
          ...checkpoint,
          status: 'completed',
          completedAt: new Date().toISOString(),
        },
        statusMessage: `Generated ${artifact.files.length} complete files. Preparing an isolated candidate.`,
      });
      await this.persistEvent(preparing, 'generation.completed', preparing.statusMessage);
      await this.scheduleResume(1);
      return;
    }

    if (
      snapshot.state === 'PREPARING_CANDIDATE'
      || snapshot.state === 'BUILDING'
      || snapshot.state === 'SERVER_PROBING'
    ) {
      const artifact = await this.getArtifact(snapshot.revision);
      if (!artifact) throw new Error(`Stored artifact for revision ${snapshot.revision} is missing`);
      const sandboxId = getCandidateSandboxId(snapshot.runId, snapshot.revision);
      let building = snapshot;
      if (snapshot.state === 'PREPARING_CANDIDATE') {
        building = transitionLaunch(snapshot, 'BUILDING', {
          candidateSandboxId: sandboxId,
          statusMessage: 'Installing dependencies and running a production build in isolation.',
          checkpoint: {
            id: `${snapshot.runId}:${snapshot.revision}:build`,
            phase: 'BUILDING',
            status: 'started',
            attempt: 1,
            idempotencyKey: `${snapshot.runId}:${snapshot.revision}:build`,
            startedAt: new Date().toISOString(),
          },
        });
        await this.persistEvent(building, 'candidate.build-started', building.statusMessage);
      }
      await this.scheduleResume(WATCHDOG_ALARM_MS);

      const origin = this.#env.CLOUDFLARE_SANDBOX_PUBLIC_URL
        || new URL(snapshot.previewUrl).origin;
      const result = await buildCandidateRuntime({
        runId: snapshot.runId,
        artifact,
        sandboxNamespace: this.#env.CODE_SANDBOX,
        publicOrigin: origin,
      });
      const latestAfterBuild = await this.requireSnapshot();
      if (latestAfterBuild.state === 'CANCELLED') {
        console.warn('[LaunchRun] Discarding candidate build after cancellation', {
          runId: snapshot.runId,
          revision: snapshot.revision,
          sandboxId: result.sandboxId,
        });
        return;
      }
      if (latestAfterBuild.sequence !== building.sequence) {
        console.warn('[LaunchRun] Discarding stale candidate build result', {
          runId: snapshot.runId,
          revision: snapshot.revision,
          buildSequence: building.sequence,
          latestSequence: latestAfterBuild.sequence,
          latestState: latestAfterBuild.state,
        });
        return;
      }
      building = latestAfterBuild;

      const probing = building.state === 'BUILDING'
        ? transitionLaunch(building, 'SERVER_PROBING', {
          candidateSandboxId: result.sandboxId,
          statusMessage: 'The production build passed. Probing the candidate server.',
        })
        : building;
      if (probing !== building) {
        await this.persistEvent(probing, 'candidate.build-passed', probing.statusMessage);
      }

      const runtimeProbing = transitionLaunch(probing, 'RUNTIME_PROBING', {
        candidateSandboxId: result.sandboxId,
        candidateProbeToken: artifact.probeToken,
        candidateUrl: result.preview.url,
        checkpoint: {
          id: `${snapshot.runId}:${snapshot.revision}:runtime`,
          phase: 'RUNTIME_PROBING',
          status: 'started',
          attempt: 1,
          idempotencyKey: `${snapshot.runId}:${snapshot.revision}:runtime`,
          startedAt: new Date().toISOString(),
        },
        statusMessage: 'Build and server checks passed. Waiting for browser runtime proof.',
      });
      await this.persistEvent(runtimeProbing, 'candidate.runtime-probe-ready', runtimeProbing.statusMessage);
      await this.scheduleResume(45_000);
      return;
    }

    if (snapshot.state === 'REPAIRING') {
      await this.advanceRecovery(snapshot);
      return;
    }

    if (snapshot.state === 'WAITING_INFRA') {
      const action = snapshot.lastFailure
        ? snapshot.recoveryHistory[snapshot.lastFailure.fingerprint]?.actions.at(-1)
        : undefined;
      const retryGeneration = action === 'fallback-model'
        || snapshot.lastFailure?.phase === 'GENERATING'
        || snapshot.lastFailure?.kind === 'model-output';
      const target = retryGeneration ? 'GENERATING' : 'PREPARING_CANDIDATE';
      const resumed = transitionLaunch(snapshot, target, {
        checkpoint: undefined,
        statusMessage: retryGeneration
          ? 'Infrastructure retry window elapsed. Regenerating the candidate.'
          : 'Infrastructure retry window elapsed. Rebuilding the isolated candidate.',
      });
      await this.persistEvent(resumed, 'recovery.retry-resumed', resumed.statusMessage);
      await this.scheduleResume(1);
      return;
    }

    if (snapshot.state === 'RUNTIME_PROBING') {
      const startedAt = Date.parse(snapshot.checkpoint?.startedAt ?? snapshot.updatedAt);
      const elapsed = Date.now() - startedAt;
      if (elapsed < 45_000) {
        await this.scheduleResume(45_000 - elapsed);
        return;
      }
      const degraded = transitionLaunch(snapshot, 'RUNNING_DEGRADED', {
        fidelity: 'baseline',
        candidateUrl: undefined,
        candidateSandboxId: undefined,
        candidateProbeToken: undefined,
        checkpoint: undefined,
        statusMessage: 'The safe interactive product remains running because browser proof was unavailable.',
      });
      await this.persistEvent(degraded, 'candidate.runtime-probe-timeout', degraded.statusMessage);
      await this.activateNextPending(degraded);
      return;
    }
  }

  protected async persistEvent(
    snapshot: LaunchSnapshot,
    type: string,
    message: string,
  ): Promise<void> {
    await this.#ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<LaunchSnapshot>(SNAPSHOT_KEY);
      if (current && current.sequence >= snapshot.sequence) {
        if (
          current.sequence === snapshot.sequence
          && current.state === snapshot.state
          && current.updatedAt === snapshot.updatedAt
        ) {
          return;
        }
        throw new Error(
          `Stale launch transition rejected: incoming ${snapshot.state}#${snapshot.sequence}, current ${current.state}#${current.sequence}`,
        );
      }
      await transaction.put(SNAPSHOT_KEY, snapshot);
      await transaction.put(eventKey(snapshot.sequence), this.createEvent(snapshot, type, message));
    });
  }

  protected async scheduleResume(delayMs: number): Promise<void> {
    await this.#ctx.storage.setAlarm(Date.now() + Math.max(1, delayMs));
  }

  // ─── Ariadne's Thread [AT-0040] ─────────────────────
  // What: Convert every failed phase into an escalating recovery transition
  // Why:  Retry caps must switch strategy or publish the safe MVP, never terminate the launch with an excuse
  // Date: 2026-09-30
  // Related: [AT-0021] shared→lib/launch/recovery-policy.ts:decideLaunchRecovery, [AT-0025] cloudflare/launch-run.ts:advance
  // ─────────────────────────────────────────────────────
  private async advanceRecovery(snapshot: LaunchSnapshot): Promise<void> {
    const failure = snapshot.lastFailure;
    if (!failure) {
      const degraded = transitionLaunch(snapshot, 'RUNNING_DEGRADED', {
        fidelity: 'baseline',
        statusMessage: 'The safe interactive product is running after an unspecified recovery condition.',
      });
      await this.persistEvent(degraded, 'recovery.safe-baseline', degraded.statusMessage);
      await this.activateNextPending(degraded);
      return;
    }

    const existing = snapshot.recoveryHistory[failure.fingerprint];
    const decision = decideLaunchRecovery(failure, existing, snapshot.fidelity);
    const recoveryRecord = recordLaunchRecovery(failure, decision.action, existing);
    const recoveryHistory = boundedRecoveryHistory({
      ...snapshot.recoveryHistory,
      [failure.fingerprint]: recoveryRecord,
    });
    console.log('[LaunchRun] Recovery strategy selected', {
      runId: snapshot.runId,
      revision: snapshot.revision,
      failureKind: failure.kind,
      failureFingerprint: failure.fingerprint,
      recoveryAction: decision.action,
      recoveryAttempt: recoveryRecord.attempts,
      delayMs: decision.delayMs,
      fidelity: decision.fidelity,
    });

    if (decision.action === 'publish-safe-baseline') {
      const degraded = transitionLaunch(snapshot, 'RUNNING_DEGRADED', {
        fidelity: 'baseline',
        candidateUrl: undefined,
        candidateSandboxId: undefined,
        candidateProbeToken: undefined,
        checkpoint: undefined,
        recoveryHistory,
        statusMessage: 'A dependency-free safe product is running after automated recovery exhausted riskier strategies.',
      });
      await this.persistEvent(degraded, 'recovery.safe-baseline', degraded.statusMessage);
      await this.#ctx.storage.deleteAlarm();
      await this.activateNextPending(degraded);
      return;
    }

    if (decision.action === 'retry' || decision.action === 'fallback-model') {
      let waiting = transitionLaunch(snapshot, 'WAITING_INFRA', {
        fidelity: decision.fidelity,
        recoveryHistory,
        checkpoint: undefined,
        statusMessage: `${decision.reason} Retrying automatically after backoff.`,
      });
      if (decision.action === 'fallback-model') {
        const fallbackModel = await this.pickFallbackModel(snapshot.request.model);
        waiting = {
          ...waiting,
          request: { ...waiting.request, model: fallbackModel },
        };
        console.log('[LaunchRun] Selected fallback generation model', {
          runId: snapshot.runId,
          revision: snapshot.revision,
          previousModel: snapshot.request.model,
          fallbackModel,
        });
      }
      await this.persistEvent(waiting, 'recovery.waiting', waiting.statusMessage);
      await this.scheduleResume(decision.delayMs);
      return;
    }

    if (decision.action === 'recreate-sandbox') {
      if (snapshot.candidateSandboxId) {
        try {
          await this.#env.CODE_SANDBOX.getByName(snapshot.candidateSandboxId).destroy();
          console.log('[LaunchRun] Destroyed failed candidate sandbox before recreation', {
            runId: snapshot.runId,
            revision: snapshot.revision,
            sandboxId: snapshot.candidateSandboxId,
          });
        } catch (error) {
          console.error('[LaunchRun] Candidate sandbox destruction failed; deterministic rebuild will continue', {
            runId: snapshot.runId,
            revision: snapshot.revision,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const recreating = transitionLaunch(snapshot, 'PREPARING_CANDIDATE', {
        fidelity: decision.fidelity,
        recoveryHistory,
        candidateUrl: undefined,
        candidateSandboxId: undefined,
        candidateProbeToken: undefined,
        checkpoint: undefined,
        statusMessage: decision.reason,
      });
      await this.persistEvent(recreating, 'recovery.sandbox-recreate', recreating.statusMessage);
      await this.scheduleResume(1);
      return;
    }

    const regenerating = transitionLaunch(snapshot, 'GENERATING', {
      fidelity: decision.fidelity,
      recoveryHistory,
      candidateUrl: undefined,
      candidateSandboxId: undefined,
      candidateProbeToken: undefined,
      checkpoint: undefined,
      statusMessage: decision.reason,
    });
    await this.persistEvent(regenerating, `recovery.${decision.action}`, regenerating.statusMessage);
    await this.scheduleResume(1);
  }

  private async queueAdvanceFailure(error: unknown, source: string): Promise<void> {
    const snapshot = await this.getSnapshot();
    if (!snapshot || snapshot.state === 'CANCELLED') return;
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = error instanceof Error ? error.stack : undefined;
    const failure = classifyLaunchFailure(message, snapshot.state, snapshot.revision, { diagnostics });
    console.error('[LaunchRun] Launch phase failed and entered recovery', {
      runId: snapshot.runId,
      revision: snapshot.revision,
      phase: snapshot.state,
      source,
      failureKind: failure.kind,
      failureFingerprint: failure.fingerprint,
      message: failure.message,
    });

    if (snapshot.state === 'RUNNING_EXACT' || snapshot.state === 'RUNNING_DEGRADED') {
      return;
    }
    if (snapshot.state === 'BASELINE_RUNNING' || !canTransitionLaunch(snapshot.state, 'REPAIRING')) {
      const degraded = transitionLaunch(snapshot, 'RUNNING_DEGRADED', {
        fidelity: 'baseline',
        lastFailure: failure,
        statusMessage: 'The safe interactive product remains running while unavailable infrastructure is bypassed.',
      });
      await this.persistEvent(degraded, 'recovery.safe-baseline', degraded.statusMessage);
      await this.activateNextPending(degraded);
      return;
    }

    const repairing = transitionLaunch(snapshot, 'REPAIRING', {
      lastFailure: failure,
      checkpoint: undefined,
      statusMessage: `Automated recovery classified a ${failure.kind} failure and is escalating strategy.`,
    });
    await this.persistEvent(repairing, 'recovery.classified', repairing.statusMessage);
    await this.scheduleResume(1);
  }

  // ─── Ariadne's Thread [AT-0038] ─────────────────────
  // What: Checkpoint generated artifacts in chunked durable storage before sandbox side effects
  // Why:  A Worker restart must replay the exact candidate instead of paying for or varying another model response
  // Date: 2026-09-30
  // Related: [AT-0036] backend→lib/ai/launch-generation-service.ts:generateLaunchArtifactText, [AT-0031] cloudflare/candidate-runtime.ts:buildCandidateRuntime
  // ─────────────────────────────────────────────────────
  private async generateArtifact(snapshot: LaunchSnapshot): Promise<LaunchArtifact> {
    const sourceParts: string[] = [];
    if (snapshot.request.context) {
      sourceParts.push(`REQUEST CONTEXT:\n${JSON.stringify(snapshot.request.context)}`);
    }
    if (snapshot.request.sourceUrl) {
      try {
        console.log('[LaunchRun] Scraping optional source URL', {
          runId: snapshot.runId,
          revision: snapshot.revision,
          sourceUrl: snapshot.request.sourceUrl,
        });
        const scraped = await this.callBuilderJson('/api/scrape-url-enhanced', {
          url: snapshot.request.sourceUrl,
        });
        sourceParts.push(`SCRAPED SOURCE:\n${JSON.stringify(scraped)}`);
      } catch (error) {
        console.error('[LaunchRun] Source scrape failed; generation will use the request and local context', {
          runId: snapshot.runId,
          revision: snapshot.revision,
          error: error instanceof Error ? error.message : String(error),
        });
        sourceParts.push(`SOURCE URL (scrape unavailable): ${snapshot.request.sourceUrl}`);
      }
    }

    const previous = snapshot.lastFailure
      ? await this.getArtifact(snapshot.revision)
      : null;
    const currentArtifact = previous
      ? previous.files.map((file) => `<file path="${file.path}">\n${file.content}\n</file>`).join('\n')
      : undefined;
    const generated = await this.callBuilderGeneration({
      prompt: snapshot.request.prompt,
      model: snapshot.request.model,
      launchMode: true,
      launchFidelity: snapshot.fidelity,
      sourceContext: sourceParts.join('\n\n'),
      diagnostics: snapshot.lastFailure
        ? `${snapshot.lastFailure.message}\n${snapshot.lastFailure.diagnostics ?? ''}`
        : undefined,
      currentArtifact,
    });

    return parseGeneratedArtifact({
      generatedCode: generated.generatedCode,
      revision: snapshot.revision,
      runId: snapshot.runId,
      packages: generated.packagesToInstall,
      explanation: generated.explanation,
      model: generated.model,
      fidelity: snapshot.fidelity,
    });
  }

  private async callBuilderGeneration(body: Record<string, unknown>): Promise<GeneratedArtifactResponse> {
    const response = await this.callBuilder('/api/generate-ai-code-stream', body);
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(`Launch generation failed with HTTP ${response.status}: ${details.slice(0, 4_000)}`);
    }
    const streamText = await response.text();
    let completed: GeneratedArtifactResponse | null = null;
    for (const line of streamText.split(/\r?\n/)) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (event.type === 'error') {
          throw new Error(String(event.error || 'Launch generation stream failed'));
        }
        if (event.type === 'complete') {
          completed = {
            generatedCode: String(event.generatedCode || ''),
            model: typeof event.model === 'string' ? event.model : undefined,
            packagesToInstall: Array.isArray(event.packagesToInstall)
              ? event.packagesToInstall.filter((item): item is string => typeof item === 'string')
              : [],
            explanation: typeof event.explanation === 'string' ? event.explanation : undefined,
          };
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.error('[LaunchRun] Ignoring malformed SSE line from generation service', {
            line: line.slice(0, 500),
          });
          continue;
        }
        throw error;
      }
    }
    if (!completed?.generatedCode) {
      throw new Error('Invalid artifact: launch generation stream completed without files');
    }
    return completed;
  }

  private async callBuilderJson(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.callBuilder(path, body);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Builder ${path} failed with HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 2_000)}`);
    }
    return payload;
  }

  private async callBuilder(path: string, body: Record<string, unknown>): Promise<Response> {
    if (!this.#env.CODE_MARKET && !this.#env.LAUNCH_BUILDER_ORIGIN) {
      throw new Error('Builder service is unavailable in this Worker environment');
    }
    const url = new URL(
      path,
      this.#env.CODE_MARKET
        ? 'http://code-market'
        : this.#env.LAUNCH_BUILDER_ORIGIN!,
    );
    console.log('[LaunchRun] Calling builder service', {
      method: 'POST',
      path: url.pathname,
      bodyKeys: Object.keys(body),
      timeoutMs: BUILDER_REQUEST_TIMEOUT_MS,
    });
    // ─── Ariadne's Thread [AT-0064] ─────────────────────
    // What: Give compact model generation six minutes and log the complete builder request outcome
    // Why:  Verified GPT-5.6-Sol generation finishes after the former four-minute boundary under normal variance
    // Date: 2026-09-30
    // Related: [AT-0062] backend→lib/ai/launch-generation-service.ts:generateLaunchArtifactText, [AT-0063] backend→lib/ai/getblock.ts:getBlockFetch
    // ─────────────────────────────────────────────────────
    const startedAt = Date.now();
    if (!this.#env.BUILDER_INTERNAL_SECRET) {
      console.error('[LaunchRun] BUILDER_INTERNAL_SECRET is missing; the builder will reject this paid request');
    }
    const request = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.#env.BUILDER_INTERNAL_SECRET
          ? { 'X-Builder-Internal-Auth': this.#env.BUILDER_INTERNAL_SECRET }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BUILDER_REQUEST_TIMEOUT_MS),
    });
    try {
      const response = this.#env.CODE_MARKET
        ? await this.#env.CODE_MARKET.getByName('code-market').fetch(request)
        : await fetch(request);
      console.log('[LaunchRun] Builder service responded', {
        method: 'POST',
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      console.error('[LaunchRun] Builder service request failed', {
        method: 'POST',
        path: url.pathname,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ─── Ariadne's Thread [AT-0065] ─────────────────────
  // What: Prefer fallback models without a published maximum output value
  // Why:  GetBlock rejects several catalog-maximum token values before generation starts
  // Date: 2026-09-30
  // Related: [AT-0015] backend→lib/ai/getblock.ts:getBlockFetch, [AT-0040] cloudflare/launch-run.ts:advanceRecovery
  // ─────────────────────────────────────────────────────
  private async pickFallbackModel(currentModel?: string): Promise<string | undefined> {
    if (!this.#env.CODE_MARKET && !this.#env.LAUNCH_BUILDER_ORIGIN) return undefined;
    try {
      const url = new URL(
        '/api/models',
        this.#env.CODE_MARKET ? 'http://code-market' : this.#env.LAUNCH_BUILDER_ORIGIN!,
      );
      const request = new Request(url, {
          method: 'GET',
          signal: AbortSignal.timeout(60_000),
      });
      const response = this.#env.CODE_MARKET
        ? await this.#env.CODE_MARKET.getByName('code-market').fetch(request)
        : await fetch(request);
      const payload = await response.json() as {
        models?: Array<{ id?: string; maxCompletionTokens?: number | null }>;
        defaultModel?: string;
      };
      const candidates = Array.isArray(payload.models)
        ? payload.models.filter((model): model is {
            id: string;
            maxCompletionTokens?: number | null;
          } => Boolean(model.id))
        : [];
      const excludedModel = currentModel || payload.defaultModel;
      const fallbackModel = candidates.find((model) => (
        model.id !== excludedModel && model.maxCompletionTokens == null
      ))?.id
        || candidates.find((model) => model.id !== excludedModel)?.id
        || (payload.defaultModel !== excludedModel ? payload.defaultModel : undefined);
      console.log('[LaunchRun] Fallback model candidate resolved', {
        currentModel: currentModel ?? null,
        excludedModel: excludedModel ?? null,
        fallbackModel: fallbackModel ?? null,
        preferredModelHadNoPublishedLimit: Boolean(
          candidates.find((model) => model.id === fallbackModel)?.maxCompletionTokens == null,
        ),
        candidateCount: candidates.length,
      });
      return fallbackModel;
    } catch (error) {
      console.error('[LaunchRun] Failed to select a fallback model', {
        currentModel,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async putArtifact(artifact: LaunchArtifact): Promise<void> {
    const prefix = `${ARTIFACT_PREFIX}${artifact.revision}`;
    const previous = await this.#ctx.storage.get<ArtifactChunks>(`${prefix}:meta`);
    const encoded = new TextEncoder().encode(JSON.stringify(artifact));
    const count = Math.ceil(encoded.byteLength / ARTIFACT_CHUNK_BYTES);
    for (let index = 0; index < count; index += 1) {
      const start = index * ARTIFACT_CHUNK_BYTES;
      const chunk = encoded.slice(start, Math.min(encoded.byteLength, start + ARTIFACT_CHUNK_BYTES));
      await this.#ctx.storage.put(`${prefix}:chunk:${index}`, chunk);
    }
    await this.#ctx.storage.put(`${prefix}:meta`, {
      count,
      bytes: encoded.byteLength,
    } satisfies ArtifactChunks);
    if (previous && previous.count > count) {
      await Promise.all(
        Array.from(
          { length: previous.count - count },
          (_, index) => this.#ctx.storage.delete(`${prefix}:chunk:${count + index}`),
        ),
      );
    }
    console.log('[LaunchRun] Artifact checkpoint persisted', {
      revision: artifact.revision,
      files: artifact.files.length,
      bytes: encoded.byteLength,
      chunks: count,
    });
  }

  private async getArtifact(revision: number): Promise<LaunchArtifact | null> {
    const prefix = `${ARTIFACT_PREFIX}${revision}`;
    const meta = await this.#ctx.storage.get<ArtifactChunks>(`${prefix}:meta`);
    if (!meta) return null;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (let index = 0; index < meta.count; index += 1) {
      const stored = await this.#ctx.storage.get<Uint8Array | ArrayBuffer>(`${prefix}:chunk:${index}`);
      if (!stored) throw new Error(`Artifact chunk ${index}/${meta.count} is missing for revision ${revision}`);
      const chunk = stored instanceof Uint8Array ? stored : new Uint8Array(stored);
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
    const joined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(joined)) as LaunchArtifact;
  }

  // ─── Ariadne's Thread [AT-0056] ─────────────────────
  // What: Activate the next persisted user revision after the current one reaches a running state
  // Why:  Sequential candidate isolation prevents concurrent edits from corrupting artifact or sandbox checkpoints
  // Date: 2026-09-30
  // Related: [AT-0055] cloudflare/launch-run.ts:submitRevision, [AT-0020] shared→lib/launch/state-machine.ts:startLaunchRevision
  // ─────────────────────────────────────────────────────
  private async activateNextPending(snapshot: LaunchSnapshot): Promise<LaunchSnapshot> {
    const outcome = await this.#ctx.storage.transaction(async (transaction) => {
      const current = (await transaction.get<LaunchSnapshot>(SNAPSHOT_KEY)) ?? snapshot;
      const pending = (await transaction.get<string[]>(PENDING_REQUESTS_KEY)) ?? [];
      if (current.state !== 'RUNNING_EXACT' && current.state !== 'RUNNING_DEGRADED') {
        return { snapshot: current, request: null, remainingPending: pending.length };
      }
      const requestId = pending.shift();
      if (!requestId) {
        return { snapshot: current, request: null, remainingPending: pending.length };
      }
      const request = await transaction.get<LaunchRequest>(`${PENDING_REQUEST_PREFIX}${requestId}`);
      if (!request) {
        if (pending.length > 0) await transaction.put(PENDING_REQUESTS_KEY, pending);
        else await transaction.delete(PENDING_REQUESTS_KEY);
        return { snapshot: current, request: null, remainingPending: pending.length };
      }
      const next = startLaunchRevision(current, request);
      await transaction.put(SNAPSHOT_KEY, next);
      if (pending.length > 0) await transaction.put(PENDING_REQUESTS_KEY, pending);
      else await transaction.delete(PENDING_REQUESTS_KEY);
      await transaction.delete(`${PENDING_REQUEST_PREFIX}${requestId}`);
      await transaction.put(eventKey(next.sequence), this.createEvent(
        next,
        'revision.started-from-queue',
        next.statusMessage,
      ));
      return { snapshot: next, request, remainingPending: pending.length };
    });
    if (!outcome.request) return outcome.snapshot;
    console.log('[LaunchRun] Activated queued revision', {
      runId: outcome.snapshot.runId,
      revision: outcome.snapshot.revision,
      remainingPending: outcome.remainingPending,
      idempotencyKey: outcome.request.idempotencyKey,
    });
    await this.scheduleResume(1);
    return outcome.snapshot;
  }

  private async safeBaselineResponse(snapshot: LaunchSnapshot): Promise<Response> {
    const html = await this.#ctx.storage.get<string>(BASELINE_HTML_KEY);
    return new Response(html ?? 'Safe preview is unavailable', {
      status: html ? 200 : 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'X-Open-Lovable-Run': snapshot.runId,
        'X-Open-Lovable-Fidelity': snapshot.fidelity,
      },
    });
  }

  private createEvent(snapshot: LaunchSnapshot, type: string, message: string): LaunchEvent {
    return {
      sequence: snapshot.sequence,
      type,
      timestamp: snapshot.updatedAt,
      message,
      snapshot: {
        ...snapshot,
        request: {
          ...snapshot.request,
          prompt: `[persisted prompt: ${snapshot.request.prompt.length} characters]`,
          context: undefined,
        },
      },
    };
  }

  private async requireSnapshot(): Promise<LaunchSnapshot> {
    const snapshot = await this.getSnapshot();
    if (!snapshot) throw new Error('Launch run has not been initialized');
    return snapshot;
  }

  private async runWithLease(source: string): Promise<void> {
    const owner = crypto.randomUUID();
    const acquired = await this.acquireLease(owner);
    if (!acquired) {
      console.log('[LaunchRun] Resume skipped because another runner owns the lease', { source });
      await this.scheduleResume(15_000);
      return;
    }
    const heartbeat = setInterval(() => {
      this.#ctx.waitUntil(this.renewLease(owner));
    }, LEASE_HEARTBEAT_MS);
    try {
      await this.advance();
    } catch (error) {
      await this.queueAdvanceFailure(error, source);
    } finally {
      clearInterval(heartbeat);
      await this.releaseLease(owner);
    }
  }

  private async acquireLease(owner: string): Promise<boolean> {
    return this.#ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<LaunchLease>(LEASE_KEY);
      if (existing && existing.expiresAt > Date.now()) return false;
      await transaction.put(LEASE_KEY, {
        owner,
        expiresAt: Date.now() + LEASE_DURATION_MS,
      } satisfies LaunchLease);
      return true;
    });
  }

  private async releaseLease(owner: string): Promise<void> {
    await this.#ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<LaunchLease>(LEASE_KEY);
      if (existing?.owner === owner) await transaction.delete(LEASE_KEY);
    });
  }

  private async renewLease(owner: string): Promise<void> {
    await this.#ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<LaunchLease>(LEASE_KEY);
      if (existing?.owner !== owner) return;
      await transaction.put(LEASE_KEY, {
        owner,
        expiresAt: Date.now() + LEASE_DURATION_MS,
      } satisfies LaunchLease);
    });
    console.log('[LaunchRun] Runner lease heartbeat renewed', { owner });
  }
}
