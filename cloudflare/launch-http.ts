import type { LaunchRun, StartLaunchInput } from './launch-run';
import type { BuilderPromptStore } from './builder-prompt-store';
import {
  PromptLedgerConflict,
  PromptOwnershipError,
} from '../lib/launch/prompt-ledger';
import type {
  LaunchRequest,
  LaunchRuntimeReport,
} from '../lib/launch/types';

const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{6,61}[a-z0-9])$/;

export interface LaunchWorkerEnv {
  LAUNCH_RUN: DurableObjectNamespace<LaunchRun>;
  BUILDER_PROMPTS: DurableObjectNamespace<BuilderPromptStore>;
  CLOUDFLARE_SANDBOX_SECRET?: string;
}

function authorize(request: Request, env: LaunchWorkerEnv): boolean {
  const expected = env.CLOUDFLARE_SANDBOX_SECRET;
  if (!expected) {
    console.error('[launch-http] CLOUDFLARE_SANDBOX_SECRET is not set');
    return false;
  }
  const authorization = request.headers.get('authorization') ?? '';
  return authorization === `Bearer ${expected}`;
}

function readCodeMarketUser(request: Request): { userId: string; email: string } | null {
  const userId = request.headers.get('x-code-market-user-id')?.trim() || '';
  let email = '';
  try {
    email = decodeURIComponent(request.headers.get('x-code-market-user-email') || '').trim().toLowerCase();
  } catch (error) {
    console.error('[launch-http] Code Market email header could not be decoded', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!/^\d+$/.test(userId) || !email.includes('@') || email.length > 320) return null;
  return { userId, email };
}

function validRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

async function createRunId(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(idempotencyKey),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `lr-${hex.slice(0, 24)}`;
}

function createLaunchRequest(
  body: Record<string, unknown>,
  request: Request,
): LaunchRequest {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new Error('prompt is required');
  if (prompt.length > 32_000) throw new Error('prompt is too large');

  const headerKey = request.headers.get('idempotency-key')?.trim();
  const bodyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const idempotencyKey = headerKey || bodyKey || crypto.randomUUID();

  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
    ? body.context as Record<string, unknown>
    : undefined;
  if (context && JSON.stringify(context).length > 32_000) {
    throw new Error('context is too large');
  }

  return {
    prompt,
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
    sourceUrl: typeof body.sourceUrl === 'string' && body.sourceUrl.trim()
      ? body.sourceUrl.trim()
      : undefined,
    context,
    idempotencyKey,
  };
}

function proxyRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.protocol = 'http:';
  url.host = 'launch-run';
  url.pathname = pathname;
  return new Request(url, request);
}

function sseResponse(events: Awaited<ReturnType<LaunchRun['getEvents']>>): Response {
  const records = events.events.map((event) => [
    `id: ${event.sequence}`,
    `data: ${JSON.stringify(event)}`,
    '',
  ].join('\n'));
  if (records.length === 0) records.push(': heartbeat\n');
  const body = `retry: 1000\n${records.join('\n')}`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ─── Ariadne's Thread [AT-0026] ─────────────────────
// What: Expose authenticated launch control routes and a public stable preview gateway
// Why:  The browser needs resumable events without receiving the Worker control secret, while preview assets remain embeddable
// Date: 2026-09-30
// Related: [AT-0025] infra→cloudflare/launch-run.ts:LaunchRun, [AT-0011] infra→cloudflare/sandbox-http.ts:routeSandboxRequest
// ─────────────────────────────────────────────────────
export async function routeLaunchRequest(
  request: Request,
  env: LaunchWorkerEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const previewMatch = /^\/launch-runs\/([^/]+)\/(preview|candidate\/(\d+))(\/.*)?$/.exec(url.pathname);
  if (previewMatch) {
    const runId = previewMatch[1];
    if (!validRunId(runId)) return new Response('Not found', { status: 404 });
    const route = previewMatch[2].startsWith('candidate/')
      ? `/candidate/${previewMatch[3]}${previewMatch[4] || '/'}`
      : `/preview${previewMatch[4] || '/'}`;
    return env.LAUNCH_RUN.getByName(runId).fetch(proxyRequest(request, route));
  }

  if (url.pathname !== '/launch-runs' && !url.pathname.startsWith('/launch-runs/')) {
    return null;
  }
  if (!authorize(request, env)) {
    console.warn('[launch-http] Rejected launch control request without a valid secret', {
      method: request.method,
      path: url.pathname,
    });
    return new Response('Unauthorized', { status: 401 });
  }

  if (url.pathname === '/builder-prompts' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') || 50);
    const cursor = url.searchParams.get('cursor') || undefined;
    const page = await env.BUILDER_PROMPTS.getByName('builder-prompts').list(cursor, limit);
    console.log('[launch-http] Stored Builder prompts listed', {
      count: page.prompts.length,
      hasMore: Boolean(page.nextCursor),
    });
    return Response.json({ success: true, ...page });
  }

  if (url.pathname === '/launch-runs' && request.method === 'POST') {
    try {
      const body = await request.json<Record<string, unknown>>();
      const requestedRunId = typeof body.runId === 'string' ? body.runId.trim() : '';
      const launchRequest = createLaunchRequest(body, request);
      const codeMarketUser = readCodeMarketUser(request);
      if (!codeMarketUser) {
        console.warn('[launch-http] Launch start rejected without a verified Code Market user');
        return Response.json({ success: false, error: 'Sign in to Code Market before using Builder.' }, { status: 401 });
      }
      const runId = requestedRunId || await createRunId(launchRequest.idempotencyKey);
      if (!validRunId(runId)) return new Response('Invalid runId', { status: 400 });
      // ─── Ariadne's Thread [AT-0075] ─────────────────────
      // What: Save the original prompt and account before the launch state machine starts
      // Why:  A failed ledger write must prevent model generation, and retries must not duplicate the saved request
      // Date: 2026-09-30
      // Related: [AT-0076] shared→lib/launch/prompt-ledger.ts:recordInitialPrompt, [AT-0078] cloudflare/builder-prompt-store.ts:BuilderPromptStore
      // ─────────────────────────────────────────────────────
      await env.BUILDER_PROMPTS.getByName('builder-prompts').recordInitial({
        runId,
        idempotencyKey: launchRequest.idempotencyKey,
        userId: codeMarketUser.userId,
        email: codeMarketUser.email,
        prompt: launchRequest.prompt,
        model: launchRequest.model,
        sourceUrl: launchRequest.sourceUrl,
      });
      const input: StartLaunchInput = {
        runId,
        previewUrl: `${url.origin}/launch-runs/${runId}/preview/`,
        request: launchRequest,
      };
      console.log('[launch-http] Starting launch run', {
        runId,
        userId: codeMarketUser.userId,
        idempotencyKey: launchRequest.idempotencyKey,
        promptChars: launchRequest.prompt.length,
        hasSourceUrl: Boolean(launchRequest.sourceUrl),
      });
      const snapshot = await env.LAUNCH_RUN.getByName(runId).start(input);
      return Response.json({ success: true, snapshot }, { status: 202 });
    } catch (error) {
      console.error('[launch-http] Start request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      const message = error instanceof Error ? error.message : String(error);
      const validationError = error instanceof SyntaxError || /prompt is required|too large|JSON/i.test(message);
      const status = error instanceof PromptLedgerConflict ? 409 : validationError ? 400 : 503;
      return Response.json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, { status });
    }
  }

  const routeMatch = /^\/launch-runs\/([^/]+)(?:\/(events|revisions|runtime-report))?$/.exec(url.pathname);
  if (!routeMatch) return new Response('Not found', { status: 404 });
  const runId = routeMatch[1];
  const resource = routeMatch[2];
  if (!validRunId(runId)) return new Response('Invalid runId', { status: 400 });
  const run = env.LAUNCH_RUN.getByName(runId);

  try {
    if (!resource && request.method === 'GET') {
      const snapshot = await run.getSnapshot();
      return snapshot
        ? Response.json({ success: true, snapshot })
        : Response.json({ success: false, error: 'Launch run not found' }, { status: 404 });
    }

    if (!resource && request.method === 'DELETE') {
      return Response.json({ success: true, snapshot: await run.cancel() });
    }

    if (resource === 'events' && request.method === 'GET') {
      const headerSequence = Number(request.headers.get('last-event-id') || 0);
      const querySequence = Number(url.searchParams.get('after') || 0);
      const after = Math.max(
        Number.isFinite(querySequence) ? querySequence : 0,
        Number.isFinite(headerSequence) ? headerSequence : 0,
      );
      let events = await run.getEvents(after);
      for (let poll = 0; events.events.length === 0 && poll < 20 && !request.signal.aborted; poll += 1) {
        try {
          await scheduler.wait(1_000, { signal: request.signal });
        } catch {
          break;
        }
        events = await run.getEvents(after);
      }
      return sseResponse(events);
    }

    if (resource === 'revisions' && request.method === 'POST') {
      const codeMarketUser = readCodeMarketUser(request);
      if (!codeMarketUser) {
        return Response.json({ success: false, error: 'Sign in to Code Market before using Builder.' }, { status: 401 });
      }
      try {
        await env.BUILDER_PROMPTS.getByName('builder-prompts').assertOwner(runId, codeMarketUser.userId);
      } catch (error) {
        const status = error instanceof PromptOwnershipError ? error.status : 503;
        console.error('[launch-http] Revision ownership check failed', {
          runId,
          userId: codeMarketUser.userId,
          status,
          error: error instanceof Error ? error.message : String(error),
        });
        return Response.json({
          success: false,
          error: error instanceof Error ? error.message : 'Launch ownership check failed',
        }, { status });
      }
      const body = await request.json<Record<string, unknown>>();
      const launchRequest = createLaunchRequest(body, request);
      const snapshot = await run.submitRevision(launchRequest);
      return Response.json({ success: true, snapshot }, { status: 202 });
    }

    if (resource === 'runtime-report' && request.method === 'POST') {
      const body = await request.json<LaunchRuntimeReport>();
      if (body.runId !== runId) return new Response('runId mismatch', { status: 400 });
      const snapshot = await run.reportRuntime(body);
      return Response.json({ success: true, snapshot }, { status: 202 });
    }
  } catch (error) {
    console.error('[launch-http] Launch route failed', {
      runId,
      resource,
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
    return Response.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }

  return new Response('Method not allowed', { status: 405 });
}
