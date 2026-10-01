import { randomUUID } from 'crypto';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { readBuilderSession } from '@/lib/auth/builder-session';
import { builderPlanAmountCents, isBuilderPlanId } from '@/lib/billing/builder-plans';

export const dynamic = 'force-dynamic';

const ORDERS_FILE = path.join(process.cwd(), 'data', 'builder-orders.jsonl');

interface BuilderOrder {
  id: string;
  userId: string;
  email: string;
  planId: string;
  interval: 'month' | 'year';
  amountCents: number;
  currency: 'usd';
  status: 'pending';
  createdAt: string;
}

// ─── Ariadne's Thread [AT-0096] ─────────────────────
// What: Record a pending builder plan order when Choose is clicked
// Why:  The paywall must create an order on this backend before any later payment step
// Date: 2026-10-01
// Related: [AT-0071] lib/auth/builder-session.ts:readBuilderSession, [AT-0093] frontend→components/app/home/BuilderPaywall.tsx:BuilderPaywall
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
  if (!isBuilderPlanId(planId)) {
    console.warn('[builder-orders] Rejected unknown plan', { planId });
    return NextResponse.json({ success: false, error: 'Unknown plan.' }, { status: 400 });
  }

  const order: BuilderOrder = {
    id: `ord_${randomUUID()}`,
    userId: session.user.id,
    email: session.user.email,
    planId,
    interval: annual ? 'year' : 'month',
    amountCents: builderPlanAmountCents(planId, annual),
    currency: 'usd',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await mkdir(path.dirname(ORDERS_FILE), { recursive: true });
  await appendFile(ORDERS_FILE, `${JSON.stringify(order)}\n`, 'utf8');
  console.log('[builder-orders] Pending order created', {
    orderId: order.id,
    userId: order.userId,
    planId: order.planId,
    interval: order.interval,
    amountCents: order.amountCents,
  });

  return NextResponse.json({
    success: true,
    order: {
      id: order.id,
      planId: order.planId,
      interval: order.interval,
      amountCents: order.amountCents,
      currency: order.currency,
      status: order.status,
      createdAt: order.createdAt,
    },
  });
}
