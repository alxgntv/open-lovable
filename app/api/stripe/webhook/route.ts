import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { launchWorkerFetch } from '@/lib/launch/worker-client';

export const dynamic = 'force-dynamic';

function stripeSignatureMatches(payload: string, header: string, secret: string): boolean {
  const fields = header.split(',').map((part) => part.trim());
  const timestamp = fields.find((part) => part.startsWith('t='))?.slice(2) || '';
  const signatures = fields.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    console.warn('[stripe-webhook] Signature timestamp is outside the allowed window', { ageSeconds });
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  return signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  });
}

// ─── Ariadne's Thread [AT-0109] ─────────────────────
// What: Mark a builder order paid after Stripe Checkout completes
// Why:  The hosted payment page must unlock the same order row Choose created
// Date: 2026-10-11
// Related: [AT-0108] backend→lib/billing/stripe-checkout.ts:createBuilderCheckoutSession, [AT-0105] shared→lib/launch/builder-orders.ts:markBuilderOrderPaid
// ─────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is missing');
    return NextResponse.json({ success: false, error: 'Stripe webhook is not configured.' }, { status: 503 });
  }
  const payload = await request.text();
  const signature = request.headers.get('stripe-signature') || '';
  if (!stripeSignatureMatches(payload, signature, secret)) {
    console.warn('[stripe-webhook] Rejected unsigned Stripe event');
    return NextResponse.json({ success: false, error: 'Invalid Stripe signature.' }, { status: 400 });
  }
  const event = JSON.parse(payload) as {
    type?: string;
    data?: { object?: { client_reference_id?: string; payment_status?: string; metadata?: { order_id?: string } } };
  };
  console.log('[stripe-webhook] Received Stripe event', { type: event.type });
  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ success: true, ignored: true });
  }
  const session = event.data?.object;
  const orderId = session?.metadata?.order_id || session?.client_reference_id || '';
  if (session?.payment_status && session.payment_status !== 'paid') {
    console.log('[stripe-webhook] Checkout is not paid yet', { orderId, paymentStatus: session.payment_status });
    return NextResponse.json({ success: true, pending: true });
  }
  if (!orderId.startsWith('ord_')) {
    console.warn('[stripe-webhook] Completed checkout has no builder order id');
    return NextResponse.json({ success: false, error: 'Missing order.' }, { status: 400 });
  }
  const response = await launchWorkerFetch('/builder-orders', {
    method: 'PATCH',
    body: JSON.stringify({ orderId }),
  }, 8_000);
  console.log('[stripe-webhook] Paid update finished', { orderId, status: response.status });
  if (!response.ok) {
    return NextResponse.json({ success: false, error: 'Order could not be marked paid.' }, { status: 502 });
  }
  return NextResponse.json({ success: true });
}
