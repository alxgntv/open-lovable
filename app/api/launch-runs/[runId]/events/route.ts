import { NextRequest, NextResponse } from 'next/server';
import {
  launchOrchestratorEnabled,
  launchWorkerFetch,
} from '@/lib/launch/worker-client';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

// ─── Ariadne's Thread [AT-0046] ─────────────────────
// What: Proxy sequence-resumable launch events as SSE
// Why:  Browser reconnects must recover every persisted transition without exposing Worker credentials
// Date: 2026-09-30
// Related: [AT-0026] infra→cloudflare/launch-http.ts:sseResponse, [AT-0043] lib/launch/worker-client.ts:launchWorkerFetch
// ─────────────────────────────────────────────────────
export async function GET(request: NextRequest, context: RouteContext) {
  if (!launchOrchestratorEnabled()) {
    return NextResponse.json({ success: false, error: 'Durable launch orchestration is disabled.' }, { status: 409 });
  }
  const { runId } = await context.params;
  const after = request.nextUrl.searchParams.get('after') || request.headers.get('last-event-id') || '0';
  try {
    const response = await launchWorkerFetch(
      `/launch-runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}`,
      {
        headers: request.headers.get('last-event-id')
          ? { 'Last-Event-ID': request.headers.get('last-event-id')! }
          : undefined,
      },
      65_000,
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('[launch-events-api] Event proxy failed', { runId, after, error });
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Launch event stream failed',
    }, { status: 502 });
  }
}
