'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  LaunchEvent,
  LaunchRuntimeReport,
  LaunchSnapshot,
} from '@/lib/launch/types';

interface SubmitLaunchInput {
  prompt: string;
  model?: string;
  sourceUrl?: string;
  context?: Record<string, unknown>;
}

interface LaunchApiResponse {
  success: boolean;
  enabled?: boolean;
  snapshot?: LaunchSnapshot;
  error?: string;
}

interface LaunchApiError extends Error {
  status: number;
}

interface RuntimeProbeMessage extends LaunchRuntimeReport {
  source: 'open-lovable-runtime-probe';
}

function isRuntimeProbeMessage(value: unknown): value is RuntimeProbeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeProbeMessage>;
  return candidate.source === 'open-lovable-runtime-probe'
    && typeof candidate.runId === 'string'
    && typeof candidate.revision === 'number'
    && (
      candidate.status === 'boot'
      || candidate.status === 'ready'
      || candidate.status === 'error'
      || candidate.status === 'blank-root'
    )
    && typeof candidate.idempotencyKey === 'string';
}

// ─── Ariadne's Thread [AT-0048] ─────────────────────
// What: Subscribe the generation UI to one resumable launch run and relay hidden-iframe runtime proof
// Why:  Reloads, SSE reconnects, and browser smoke tests must update server-owned state instead of restarting generation
// Date: 2026-09-30
// Related: [AT-0044] backend→app/api/launch-runs/route.ts, [AT-0046] backend→app/api/launch-runs/[runId]/events/route.ts, [AT-0022] shared→lib/launch/safe-baseline.ts:createRuntimeProbeScript
// ─────────────────────────────────────────────────────
export function useLaunchRun(initialRunId?: string | null) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<LaunchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const snapshotRef = useRef<LaunchSnapshot | null>(null);
  const sequenceRef = useRef(0);
  const submissionRef = useRef<Promise<LaunchSnapshot> | null>(null);

  const acceptSnapshot = useCallback((next: LaunchSnapshot) => {
    const current = snapshotRef.current;
    if (current && current.runId === next.runId && next.sequence < current.sequence) return;
    snapshotRef.current = next;
    sequenceRef.current = Math.max(sequenceRef.current, next.sequence);
    setSnapshot(next);
    sessionStorage.setItem('launchRunId', next.runId);
    console.log('[useLaunchRun] Snapshot accepted', {
      runId: next.runId,
      revision: next.revision,
      sequence: next.sequence,
      state: next.state,
      availability: next.availability,
      fidelity: next.fidelity,
    });
  }, []);

  const readApiResponse = useCallback(async (response: Response): Promise<LaunchApiResponse> => {
    const data = await response.json().catch(() => ({})) as LaunchApiResponse;
    if (!response.ok || !data.success) {
      const apiError = new Error(
        data.error || `Launch API failed with HTTP ${response.status}`,
      ) as LaunchApiError;
      apiError.status = response.status;
      throw apiError;
    }
    return data;
  }, []);

  const restore = useCallback(async (runId: string) => {
    console.log('[useLaunchRun] Restoring durable launch run', { runId });
    const response = await fetch(`/api/launch-runs/${encodeURIComponent(runId)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    const data = await readApiResponse(response);
    if (!data.snapshot) throw new Error('Launch API returned no snapshot');
    acceptSnapshot(data.snapshot);
    return data.snapshot;
  }, [acceptSnapshot, readApiResponse]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    const initialize = async () => {
      try {
        const capabilityResponse = await fetch('/api/launch-runs', {
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
        });
        if (!capabilityResponse.ok) {
          throw new Error(`Capability request failed with HTTP ${capabilityResponse.status}`);
        }
        const capability = await capabilityResponse.json() as LaunchApiResponse;
        const nextEnabled = capability.enabled === true;
        if (cancelled) return;
        setEnabled(nextEnabled);
        console.log('[useLaunchRun] Durable orchestrator capability', { enabled: nextEnabled });
        if (!nextEnabled) return;
        const runId = initialRunId || sessionStorage.getItem('launchRunId');
        if (!runId) return;
        try {
          await restore(runId);
        } catch (restoreError) {
          console.error('[useLaunchRun] Stored launch run could not be restored', restoreError);
          if ((restoreError as Partial<LaunchApiError>)?.status === 404) {
            sessionStorage.removeItem('launchRunId');
            return;
          }
          throw restoreError;
        }
      } catch (capabilityError) {
        if (cancelled) return;
        console.error('[useLaunchRun] Durable launch initialization failed transiently; retrying', capabilityError);
        retryTimer = window.setTimeout(() => void initialize(), 2_000);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [initialRunId, restore]);

  useEffect(() => {
    if (!enabled || !snapshot?.runId) return;
    const runId = snapshot.runId;
    const events = new EventSource(
      `/api/launch-runs/${encodeURIComponent(runId)}/events?after=${sequenceRef.current}`,
    );
    console.log('[useLaunchRun] Event stream opened', {
      runId,
      after: sequenceRef.current,
    });
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as LaunchEvent;
        if (event.sequence <= sequenceRef.current) return;
        acceptSnapshot(event.snapshot);
      } catch (parseError) {
        console.error('[useLaunchRun] Failed to parse launch event', {
          data: message.data,
          error: parseError,
        });
      }
    };
    events.onerror = () => {
      console.warn('[useLaunchRun] Event stream disconnected; EventSource will resume', {
        runId,
        lastSequence: sequenceRef.current,
      });
    };
    return () => {
      console.log('[useLaunchRun] Event stream closed', { runId });
      events.close();
    };
  }, [acceptSnapshot, enabled, snapshot?.runId]);

  useEffect(() => {
    const handleRuntimeMessage = async (event: MessageEvent<unknown>) => {
      if (!isRuntimeProbeMessage(event.data)) return;
      const current = snapshotRef.current;
      if (!current || event.data.runId !== current.runId || event.data.revision !== current.revision) {
        console.warn('[useLaunchRun] Ignoring stale runtime probe message', event.data);
        return;
      }
      const allowedOrigins = new Set(
        [current.previewUrl, current.candidateUrl]
          .filter((url): url is string => Boolean(url))
          .map((url) => new URL(url, window.location.href).origin),
      );
      if (!allowedOrigins.has(event.origin)) {
        console.warn('[useLaunchRun] Ignoring runtime probe from an unexpected origin', {
          origin: event.origin,
          allowedOrigins: [...allowedOrigins],
        });
        return;
      }
      console.log('[useLaunchRun] Relaying runtime probe', {
        runId: event.data.runId,
        revision: event.data.revision,
        status: event.data.status,
        rootChildCount: event.data.rootChildCount,
      });
      try {
        let attempt = 0;
        while (true) {
          attempt += 1;
          try {
            const response = await fetch(
              `/api/launch-runs/${encodeURIComponent(current.runId)}/runtime-report`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(event.data),
                signal: AbortSignal.timeout(30_000),
              },
            );
            if (!response.ok && response.status < 500 && response.status !== 408 && response.status !== 429) {
              const failure = await response.clone().json().catch(() => ({})) as LaunchApiResponse;
              const definitiveError = new Error(
                failure.error || `Runtime report rejected with HTTP ${response.status}`,
              ) as Error & { retryable?: boolean };
              definitiveError.retryable = false;
              throw definitiveError;
            }
            const data = await readApiResponse(response);
            if (data.snapshot) acceptSnapshot(data.snapshot);
            break;
          } catch (requestError) {
            if ((requestError as Error & { retryable?: boolean })?.retryable === false) {
              throw requestError;
            }
            const latest = snapshotRef.current;
            if (!latest || latest.runId !== current.runId || latest.revision !== current.revision) {
              console.warn('[useLaunchRun] Runtime report retry stopped because the candidate was superseded', {
                runId: current.runId,
                revision: current.revision,
                attempt,
              });
              break;
            }
            const delayMs = Math.min(10_000, 500 * (2 ** Math.min(attempt - 1, 5)));
            console.error('[useLaunchRun] Runtime report failed transiently; retrying', {
              runId: current.runId,
              revision: current.revision,
              status: event.data.status,
              attempt,
              delayMs,
              error: requestError instanceof Error ? requestError.message : String(requestError),
            });
            await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          }
        }
      } catch (reportError) {
        console.error('[useLaunchRun] Runtime report relay failed', reportError);
        setError(reportError instanceof Error ? reportError.message : 'Runtime report failed');
      }
    };
    window.addEventListener('message', handleRuntimeMessage);
    return () => window.removeEventListener('message', handleRuntimeMessage);
  }, [acceptSnapshot, readApiResponse]);

  const submit = useCallback((input: SubmitLaunchInput): Promise<LaunchSnapshot> => {
    if (submissionRef.current) {
      console.log('[useLaunchRun] Reusing the in-flight launch submission');
      return submissionRef.current;
    }
    const operation = (async () => {
      let active = enabled;
      if (active === null) {
        const capabilityResponse = await fetch('/api/launch-runs', { cache: 'no-store' });
        const capability = await capabilityResponse.json() as LaunchApiResponse;
        active = capabilityResponse.ok && capability.enabled === true;
        setEnabled(active);
      }
      if (!active) throw new Error('Durable launch orchestration is not enabled');
      const prompt = input.prompt.trim();
      if (!prompt) throw new Error('A product request is required');
      setIsSubmitting(true);
      setError(null);
      const current = snapshotRef.current;
      const idempotencyKey = crypto.randomUUID();
      const endpoint = current && current.state !== 'CANCELLED'
        ? `/api/launch-runs/${encodeURIComponent(current.runId)}`
        : '/api/launch-runs';
      console.log('[useLaunchRun] Submitting launch request', {
        endpoint,
        runId: current?.runId,
        currentRevision: current?.revision,
        idempotencyKey,
        hasSourceUrl: Boolean(input.sourceUrl),
      });
      try {
        const requestBody = JSON.stringify({
          ...input,
          prompt,
          idempotencyKey,
        });
        let response: Response;
        let attempt = 0;
        while (true) {
          attempt += 1;
          try {
            response = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
              },
              body: requestBody,
              signal: AbortSignal.timeout(60_000),
            });
            if (response.ok) break;
            const failure = await response.clone().json().catch(() => ({})) as LaunchApiResponse;
            const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            if (!retryable) {
              const definitiveError = new Error(
                failure.error || `Launch API rejected the request with HTTP ${response.status}`,
              ) as Error & { retryable?: boolean };
              definitiveError.retryable = false;
              throw definitiveError;
            }
            throw new Error(failure.error || `Transient launch API response ${response.status}`);
          } catch (requestError) {
            const message = requestError instanceof Error ? requestError.message : String(requestError);
            if ((requestError as Error & { retryable?: boolean })?.retryable === false) {
              throw requestError;
            }
            const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(attempt - 1, 5)));
            console.error('[useLaunchRun] Transient launch submission failure; retrying', {
              endpoint,
              idempotencyKey,
              attempt,
              delayMs,
              error: message,
            });
            await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          }
        }
        const data = await readApiResponse(response);
        if (!data.snapshot) throw new Error('Launch API returned no snapshot');
        acceptSnapshot(data.snapshot);
        return data.snapshot;
      } catch (submitError) {
        const message = submitError instanceof Error ? submitError.message : 'Launch submission failed';
        console.error('[useLaunchRun] Launch submission failed', {
          endpoint,
          idempotencyKey,
          error: submitError,
        });
        setError(message);
        throw submitError;
      } finally {
        setIsSubmitting(false);
      }
    })();
    submissionRef.current = operation;
    void operation.finally(() => {
      if (submissionRef.current === operation) submissionRef.current = null;
    }).catch(() => undefined);
    return operation;
  }, [acceptSnapshot, enabled, readApiResponse]);

  const refresh = useCallback(async () => {
    const runId = snapshotRef.current?.runId;
    if (!runId) return null;
    return restore(runId);
  }, [restore]);

  return {
    enabled,
    snapshot,
    error,
    isSubmitting,
    submit,
    refresh,
    candidateUrl: snapshot?.state === 'RUNTIME_PROBING' ? snapshot.candidateUrl : undefined,
  };
}
