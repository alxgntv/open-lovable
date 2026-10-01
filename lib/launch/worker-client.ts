import 'server-only';

const DEFAULT_TIMEOUT_MS = 60_000;

export function launchOrchestratorEnabled(): boolean {
  return process.env.LAUNCH_ORCHESTRATOR_V2_ENABLED === 'true';
}

// ─── Ariadne's Thread [AT-0043] ─────────────────────
// What: Proxy authenticated launch control requests from Next.js to the Cloudflare Worker
// Why:  Browser clients must never receive the sandbox control secret, and every route needs identical timeout logging
// Date: 2026-09-30
// Related: [AT-0026] infra→cloudflare/launch-http.ts:routeLaunchRequest, app/api/launch-runs/route.ts
// ─────────────────────────────────────────────────────
export async function launchWorkerFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const workerUrl = (process.env.CLOUDFLARE_SANDBOX_URL || '').replace(/\/$/, '');
  const secret = process.env.CLOUDFLARE_SANDBOX_SECRET || '';
  if (!workerUrl) throw new Error('CLOUDFLARE_SANDBOX_URL is not configured');
  if (!secret) throw new Error('CLOUDFLARE_SANDBOX_SECRET is not configured');

  const url = `${workerUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${secret}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  console.log('[launch-worker-client] Request', {
    method: init.method || 'GET',
    path,
    timeoutMs,
    hasBody: Boolean(init.body),
  });
  const startedAt = Date.now();
  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  console.log('[launch-worker-client] Response', {
    method: init.method || 'GET',
    path,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return response;
}

export async function proxyLaunchJson(response: Response): Promise<Response> {
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
