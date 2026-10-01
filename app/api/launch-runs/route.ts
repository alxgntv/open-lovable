import { NextRequest, NextResponse } from 'next/server';
import {
  launchOrchestratorEnabled,
  launchWorkerFetch,
  proxyLaunchJson,
} from '@/lib/launch/worker-client';
import {
  codeMarketUserHeaders,
  requireCodeMarketUser,
} from '@/lib/auth/builder-session';

export const dynamic = 'force-dynamic';

// ─── Ariadne's Thread [AT-0044] ─────────────────────
// What: Add the browser-facing create and capability endpoint for durable launch runs
// Why:  The generation UI needs a server-side feature gate and a secret-free path to the Worker coordinator
// Date: 2026-09-30
// Related: [AT-0043] lib/launch/worker-client.ts:launchWorkerFetch, [AT-0026] infra→cloudflare/launch-http.ts:routeLaunchRequest
// ─────────────────────────────────────────────────────
export async function GET() {
  const enabled = launchOrchestratorEnabled();
  console.log('[launch-runs-api] Capability requested', { enabled });
  return NextResponse.json({ success: true, enabled });
}

export async function POST(request: NextRequest) {
  if (!launchOrchestratorEnabled()) {
    console.warn('[launch-runs-api] Create rejected because the orchestrator feature flag is disabled');
    return NextResponse.json({
      success: false,
      enabled: false,
      error: 'Durable launch orchestration is disabled.',
    }, { status: 409 });
  }

  // ─── Ariadne's Thread [AT-0072] ─────────────────────
  // What: Require a verified Code Market user before a launch can spend tokens
  // Why:  The Worker stores that user with the original prompt and rejects later revisions from another account
  // Date: 2026-09-30
  // Related: [AT-0071] lib/auth/builder-session.ts:requireCodeMarketUser, [AT-0075] infra→cloudflare/launch-http.ts:routeLaunchRequest
  // ─────────────────────────────────────────────────────
  const user = await requireCodeMarketUser(request);
  if (user instanceof NextResponse) return user;

  try {
    const body = await request.text();
    const idempotencyKey = request.headers.get('idempotency-key') || crypto.randomUUID();
    const response = await launchWorkerFetch('/launch-runs', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        ...codeMarketUserHeaders(user),
      },
      body,
    });
    return proxyLaunchJson(response);
  } catch (error) {
    console.error('[launch-runs-api] Create failed', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Launch run creation failed',
    }, { status: 502 });
  }
}
