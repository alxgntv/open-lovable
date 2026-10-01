import { NextRequest, NextResponse } from 'next/server';
import {
  launchOrchestratorEnabled,
  launchWorkerFetch,
  proxyLaunchJson,
} from '@/lib/launch/worker-client';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

// ─── Ariadne's Thread [AT-0047] ─────────────────────
// What: Forward candidate browser boot, ready, blank-root, and runtime-error proof
// Why:  Atomic promotion requires evidence from an executing DOM, not only server-side HTTP success
// Date: 2026-09-30
// Related: [AT-0022] shared→lib/launch/safe-baseline.ts:createRuntimeProbeScript, [AT-0035] infra→cloudflare/launch-run.ts:reportRuntime
// ─────────────────────────────────────────────────────
export async function POST(request: NextRequest, context: RouteContext) {
  if (!launchOrchestratorEnabled()) {
    return NextResponse.json({ success: false, error: 'Durable launch orchestration is disabled.' }, { status: 409 });
  }
  const { runId } = await context.params;
  try {
    const response = await launchWorkerFetch(
      `/launch-runs/${encodeURIComponent(runId)}/runtime-report`,
      {
        method: 'POST',
        body: await request.text(),
      },
    );
    return proxyLaunchJson(response);
  } catch (error) {
    console.error('[launch-runtime-report-api] Report failed', { runId, error });
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Runtime report failed',
    }, { status: 502 });
  }
}
