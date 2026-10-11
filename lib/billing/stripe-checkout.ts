import { builderPlanStripePriceId, type BuilderPlanId } from './builder-plans';

export interface StripeCheckoutInput {
  orderId: string;
  userId: string;
  email: string;
  planId: BuilderPlanId;
  origin: string;
}

// ─── Ariadne's Thread [AT-0108] ─────────────────────
// What: Open a Stripe Checkout subscription for one builder plan price
// Why:  Choose must charge the live {c} Builder prices, not only store a pending row
// Date: 2026-10-11
// Related: [AT-0106] backend→app/api/builder-orders/route.ts:POST, [AT-0105] shared→lib/launch/builder-orders.ts:saveBuilderOrder
// ─────────────────────────────────────────────────────
export async function createBuilderCheckoutSession(input: StripeCheckoutInput): Promise<string> {
  const secret = process.env.STRIPE_SECRET_KEY || '';
  if (!secret) {
    console.error('[stripe-checkout] STRIPE_SECRET_KEY is missing');
    throw new Error('Stripe is not configured');
  }
  const priceId = builderPlanStripePriceId(input.planId);
  const successUrl = `${input.origin}/?checkout=success&order=${encodeURIComponent(input.orderId)}`;
  const cancelUrl = `${input.origin}/?checkout=cancel&order=${encodeURIComponent(input.orderId)}`;
  const body = new URLSearchParams({
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: input.email,
    client_reference_id: input.orderId,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'metadata[order_id]': input.orderId,
    'metadata[user_id]': input.userId,
    'metadata[plan_id]': input.planId,
  });
  console.log('[stripe-checkout] Creating Checkout Session', {
    orderId: input.orderId,
    userId: input.userId,
    planId: input.planId,
    priceId,
  });
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => null) as { url?: string; error?: { message?: string } } | null;
  if (!response.ok || !payload?.url) {
    console.error('[stripe-checkout] Checkout Session rejected', {
      orderId: input.orderId,
      status: response.status,
      message: payload?.error?.message || 'missing url',
    });
    throw new Error(payload?.error?.message || 'Stripe Checkout could not be started');
  }
  console.log('[stripe-checkout] Checkout Session created', { orderId: input.orderId, planId: input.planId });
  return payload.url;
}
