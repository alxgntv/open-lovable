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

interface RouteContext {
  params: Promise<{ runId: string }>;
}

function disabledResponse(): NextResponse {
  return NextResponse.json({
    success: false,
    enabled: false,
    error: 'Durable launch orchestration is disabled.',
  }, { status: 409 });
}

// ─── Ariadne's Thread [AT-0045] ─────────────────────
// What: Restore, revise, and explicitly cancel one durable launch run
// Why:  Reloads and edits must target the persisted run instead of creating duplicate client pipelines
// Date: 2026-09-30
// Related: [AT-0044] app/api/launch-runs/route.ts, [AT-0025] infra→cloudflare/launch-run.ts:LaunchRun
// ─────────────────────────────────────────────────────
export async function GET(_request: NextRequest, context: RouteContext) {
  if (!launchOrchestratorEnabled()) return disabledResponse();
  const { runId } = await context.params;
  try {
    return proxyLaunchJson(await launchWorkerFetch(`/launch-runs/${encodeURIComponent(runId)}`));
  } catch (error) {
    console.error('[launch-run-api] Restore failed', { runId, error });
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Launch run restore failed',
    }, { status: 502 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  if (!launchOrchestratorEnabled()) return disabledResponse();
  const user = await requireCodeMarketUser(request);
  if (user instanceof NextResponse) return user;
  const { runId } = await context.params;
  try {
    const idempotencyKey = request.headers.get('idempotency-key') || crypto.randomUUID();
    const response = await launchWorkerFetch(`/launch-runs/${encodeURIComponent(runId)}/revisions`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        ...codeMarketUserHeaders(user),
      },
      body: await request.text(),
    });
    return proxyLaunchJson(response);
  } catch (error) {
    console.error('[launch-run-api] Revision submit failed', { runId, error });
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Launch revision submit failed',
    }, { status: 502 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  if (!launchOrchestratorEnabled()) return disabledResponse();
  const { runId } = await context.params;
  try {
    return proxyLaunchJson(await launchWorkerFetch(`/launch-runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
    }));
  } catch (error) {
    console.error('[launch-run-api] Cancel failed', { runId, error });
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Launch cancellation failed',
    }, { status: 502 });
  }
}
