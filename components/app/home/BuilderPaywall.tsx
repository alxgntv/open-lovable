'use client';

import { useState } from 'react';

const PRICING_HREF = 'https://code.market/pricing';

const PLANS = [
  {
    id: 'membership',
    price: '$14.50',
    tone: 'border-white/15 bg-[#1a1f27]',
    features: [
      '100 credits',
      'Development sandbox',
      'Download source code',
      'GitHub integration',
      'Unlimited users',
      'Credit rollovers',
      'On-demand credit top-ups',
      'Custom domains',
      'User roles and permissions',
      'Per-member credit limits',
      'Email support',
    ],
  },
  {
    id: 'credits-350',
    price: '$38',
    tone: 'border-[#3cb4e6] bg-gradient-to-b from-[#1c6f93] to-[#15202b]',
    features: [
      '350 credits',
      'Development sandbox',
      'Download source code',
      'GitHub integration',
      'Everything in the $14.50 plan',
      'Team workspace',
      'Role-based access',
      'Personal projects',
      'SSO',
      'Design templates',
      'Priority support',
    ],
  },
  {
    id: 'credits-1000',
    price: '$99',
    tone: 'border-[#c084fc] bg-gradient-to-b from-[#6d3d86] to-[#1a1424]',
    features: [
      '1,000 credits',
      'Development sandbox',
      'Included database',
      'Download source code',
      'GitHub integration',
      'Everything in the $38 plan',
      'Directory sync (SCIM)',
      'Audit logs',
      'GitHub Enterprise, cloud or self-hosted',
      'Private npm registry',
      'Custom SLA',
    ],
  },
] as const;

function annualMonthlyPrice(monthlyLabel: string): string {
  const monthly = Number(monthlyLabel.replace('$', ''));
  const amount = Math.round((monthly * 10 / 12) * 100) / 100;
  return `$${amount.toFixed(2)}`;
}

// ─── Ariadne's Thread [AT-0093] ─────────────────────
// What: Show the Code Market community plans when a signed-in account has no paid tariff
// Why:  Builder actions should stop on the published pricing page instead of opening generation
// Date: 2026-10-01
// Related: [AT-0092] backend→lib/auth/builder-session.ts:profileHasPaidPlan, [AT-0091] frontend→components/app/home/ProjectHome.tsx:openBuilder
// ─────────────────────────────────────────────────────
export default function BuilderPaywall({ onClose }: { onClose: () => void }) {
  const [annual, setAnnual] = useState(false);
  const [orderingPlanId, setOrderingPlanId] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<{ planId: string; message: string } | null>(null);

  const choosePlan = async (planId: string) => {
    setOrderingPlanId(planId);
    setOrderError(null);
    console.log('[paywall] Creating builder order', { planId, annual });
    try {
      const response = await fetch('/api/builder-orders', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, annual }),
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: string; order?: { id?: string } };
      if (!response.ok || !payload.success) {
        const message = payload.error || 'Could not create the order.';
        console.error('[paywall] Builder order failed', { planId, status: response.status, message });
        setOrderError({ planId, message });
        return;
      }
      console.log('[paywall] Builder order created', { planId, orderId: payload.order?.id ?? null });
    } catch (error) {
      console.error('[paywall] Builder order request failed', error);
      setOrderError({ planId, message: 'Could not create the order.' });
    } finally {
      setOrderingPlanId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[#071018] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(28,111,147,0.45),transparent_42%),radial-gradient(circle_at_80%_0%,rgba(109,61,134,0.35),transparent_36%)]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-[1100px] flex-col px-20 py-24">
        <div className="mb-28 flex items-center justify-end gap-12">
          <button
            type="button"
            onClick={() => {
              console.log('[paywall] Closed');
              onClose();
            }}
            className="rounded-full border border-white/15 px-14 py-8 text-[13px] text-white hover:bg-white/10"
          >
            Close
          </button>
        </div>

        <h2 className="text-center text-[34px] font-medium tracking-[-0.03em]">Pick your plan</h2>
        <div className="mx-auto mt-16 flex items-center gap-8 rounded-full bg-white/10 p-4 text-[13px]">
          <button
            type="button"
            onClick={() => {
              console.log('[paywall] Billing period selected', { annual: false });
              setAnnual(false);
            }}
            className={`rounded-full px-14 py-6 ${annual ? 'text-[#c5ceda]' : 'bg-white text-[#161616]'}`}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => {
              console.log('[paywall] Billing period selected', { annual: true });
              setAnnual(true);
            }}
            className={`flex items-center gap-8 rounded-full px-14 py-6 ${annual ? 'bg-white text-[#161616]' : 'text-[#c5ceda]'}`}
          >
            Annual
            <span className={`rounded-full px-8 py-2 text-[11px] ${annual ? 'bg-[#efe7ff] text-[#6d28d9]' : 'bg-white/10 text-[#d7c4ff]'}`}>
              2 months free
            </span>
          </button>
        </div>
        <div className="mt-28 grid grid-cols-1 gap-14 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <article key={plan.id} className={`flex flex-col rounded-18 border p-18 ${plan.tone}`}>
              {annual ? (
                <p className="text-[28px] font-semibold">
                  <span className="mr-8 text-[18px] font-medium text-white/40 line-through">{plan.price}</span>
                  {annualMonthlyPrice(plan.price)}
                  <span className="mt-4 block text-[13px] font-normal text-white/70">/ month, billed annually</span>
                </p>
              ) : (
                <p className="text-[28px] font-semibold">{plan.price}<span className="ml-4 text-[14px] font-medium text-white/70">/mo</span></p>
              )}
              <button
                type="button"
                disabled={orderingPlanId === plan.id}
                onClick={() => void choosePlan(plan.id)}
                className="mt-16 block w-full rounded-full bg-white px-14 py-10 text-center text-[14px] font-medium text-[#161616] hover:bg-white/90 disabled:cursor-wait disabled:opacity-70"
              >
                {orderingPlanId === plan.id ? 'Creating order' : 'Choose'}
              </button>
              {orderError?.planId === plan.id && (
                <p className="mt-8 text-[12px] leading-[16px] text-[#ffb4b4]">{orderError.message}</p>
              )}
              <ul className="mt-18 flex flex-col gap-8 text-[13px] leading-[18px] text-white/85">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-8">
                    <span aria-hidden="true">✓</span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="mt-28 grid grid-cols-1 gap-14 lg:grid-cols-3">
          <article className="rounded-18 border border-white/10 bg-[#12161d] p-18">
            <h3 className="text-[16px] font-semibold">{'{c}'} Builder for students</h3>
            <p className="mt-8 min-h-40 text-[13px] leading-[18px] text-[#b7c0cc]">Verify student status and get up to 50% off the $38 plan.</p>
            <a
              href="mailto:support@code.market"
              onClick={() => console.log('[paywall] Opening student support email')}
              className="mt-16 block rounded-full border border-white/15 px-14 py-10 text-center text-[14px] text-white hover:bg-white/5"
            >
              Get started
            </a>
          </article>
          <article className="rounded-18 border border-white/10 bg-[#12161d] p-18">
            <h3 className="text-[16px] font-semibold">{'{c}'} Builder for campus</h3>
            <p className="mt-8 min-h-40 text-[13px] leading-[18px] text-[#b7c0cc]">Billing and administrative controls for universities and colleges.</p>
            <a
              href="mailto:support@code.market"
              onClick={() => console.log('[paywall] Opening campus sales email')}
              className="mt-16 block rounded-full border border-white/15 px-14 py-10 text-center text-[14px] text-white hover:bg-white/5"
            >
              Contact sales
            </a>
          </article>
          <article className="rounded-18 border border-white/10 bg-[#12161d] p-18">
            <h3 className="text-[16px] font-semibold">{'{c}'} Builder for schools</h3>
            <p className="mt-8 min-h-40 text-[13px] leading-[18px] text-[#b7c0cc]">Compliant access and curriculum for schools.</p>
            <a
              href="mailto:support@code.market"
              onClick={() => console.log('[paywall] Opening school support email')}
              className="mt-16 block rounded-full border border-white/15 px-14 py-10 text-center text-[14px] text-white hover:bg-white/5"
            >
              Learn more
            </a>
          </article>
        </div>

        <div className="mt-14 flex flex-col gap-16 rounded-18 border border-white/10 bg-[#12161d] p-18 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-[16px] font-semibold">Security and compliance</h3>
            <p className="mt-6 text-[13px] leading-[18px] text-[#b7c0cc]">Enterprise-grade security and compliance certifications</p>
          </div>
          <div className="flex items-center gap-18 text-[12px] text-[#d5dbe3]">
            <span className="flex h-64 w-64 items-center justify-center rounded-full border border-white/20 text-center leading-[14px]">SOC 2<br />Type II</span>
            <span className="flex h-64 w-64 items-center justify-center rounded-full border border-white/20">GDPR</span>
            <span className="flex h-64 w-64 items-center justify-center rounded-full border border-white/20 text-center leading-[14px]">ISO<br />27001</span>
          </div>
          <a
            href="https://code.market/page/privacy-policy"
            target="_blank"
            rel="noreferrer"
            onClick={() => console.log('[paywall] Opening privacy policy')}
            className="rounded-full border border-white/15 px-14 py-10 text-center text-[14px] text-white hover:bg-white/5"
          >
            Learn more
          </a>
        </div>
      </div>
    </div>
  );
}
