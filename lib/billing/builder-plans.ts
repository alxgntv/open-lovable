export const BUILDER_PLAN_MONTHLY_CENTS = {
  membership: 1405,
  'credits-350': 3800,
  'credits-1000': 9900,
} as const;

export const BUILDER_PLAN_STRIPE_PRICE_ID = {
  membership: 'price_1UPLqR3ihBVHid5IvsiQxNQQ',
  'credits-350': 'price_1UPLqu3ihBVHid5I6Uu7EkCm',
  'credits-1000': 'price_1UPLr33ihBVHid5I78qoASu8',
} as const;

export type BuilderPlanId = keyof typeof BUILDER_PLAN_MONTHLY_CENTS;

export function isBuilderPlanId(value: string): value is BuilderPlanId {
  return value in BUILDER_PLAN_MONTHLY_CENTS;
}

export function builderPlanAmountCents(planId: BuilderPlanId, annual: boolean): number {
  const monthly = BUILDER_PLAN_MONTHLY_CENTS[planId];
  return annual ? monthly * 10 : monthly;
}

export function builderPlanStripePriceId(planId: BuilderPlanId): string {
  return BUILDER_PLAN_STRIPE_PRICE_ID[planId];
}
