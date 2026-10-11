import { NextRequest, NextResponse } from 'next/server';
import { readBuilderSession } from '@/lib/auth/builder-session';
import { isBuilderPlanId } from '@/lib/billing/builder-plans';
import { createBuilderCheckoutSession } from '@/lib/billing/stripe-checkout';
import { launchWorkerFetch } from '@/lib/launch/worker-client';

export const dynamic = 'force-dynamic';

// ─── Ariadne's Thread [AT-0106] ─────────────────────
// What: Save a pending plan order in the Builder sqlite database
// Why:  The container file could not be read, so Choose clicks never showed up with the drafts
// Date: 2026-10-05
// Related: [AT-0105] shared→lib/launch/builder-orders.ts:saveBuilderOrder, [AT-0093] frontend→components/app/home/BuilderPaywall.tsx:choosePlan
// ─────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const session = await readBuilderSession(request);
  if (session.status === 'unavailable') {
    console.error('[builder-orders] Session could not be verified');
    return NextResponse.json({ success: false, error: 'Code Market sign-in is temporarily unavailable.' }, { status: 503 });
  }
  if (session.status !== 'authenticated') {
    console.warn('[builder-orders] Rejected order without a session');
    return NextResponse.json({ success: false, error: 'Sign in to Code Market before choosing a plan.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { planId?: unknown; annual?: unknown };
  const planId = typeof body.planId === 'string' ? body.planId : '';
  const annual = body.annual === true;
  if (annual) {
    console.warn('[builder-orders] Rejected annual checkout because no annual Stripe price exists', {
      userId: session.user.id,
      planId,
    });
    return NextResponse.json({ success: false, error: 'Annual billing is not available yet.' }, { status: 400 });
  }
  if (!isBuilderPlanId(planId)) {
    console.warn('[builder-orders] Rejected unknown plan', { planId });
    return NextResponse.json({ success: false, error: 'Unknown plan.' }, { status: 400 });
  }
  console.log('[builder-orders] Creating sqlite order', {
    userId: session.user.id,
    planId,
    annual,
  });

  try {
    const response = await launchWorkerFetch('/builder-orders', {
      method: 'POST',
      body: JSON.stringify({
        userId: session.user.id,
        email: session.user.email,
        planId,
        annual,
      }),
    }, 8_000);
    const payload = await response.json().catch(() => null) as {
      success?: boolean;
      order?: { id?: string; planId?: string };
    } | null;
    const orderId = payload?.order?.id || '';
    if (!response.ok || !orderId) {
      console.error('[builder-orders] Worker rejected order', {
        userId: session.user.id,
        planId,
        status: response.status,
      });
      return NextResponse.json({ success: false, error: 'Could not create the order.' }, { status: 502 });
    }
    const checkoutUrl = await createBuilderCheckoutSession({
      orderId,
      userId: session.user.id,
      email: session.user.email,
      planId,
      origin: request.nextUrl.origin,
    });
    console.log('[builder-orders] Sqlite order created', { userId: session.user.id, planId, orderId });
    return NextResponse.json({ success: true, checkoutUrl, order: payload?.order });
  } catch (error) {
    console.error('[builder-orders] Worker request failed', {
      userId: session.user.id,
      planId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Could not create the order.' }, { status: 503 });
  }
}
