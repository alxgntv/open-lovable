export const BUILDER_PLAN_MONTHLY_CENTS = {
  membership: 1450,
  'credits-350': 3800,
  'credits-1000': 9900,
} as const;

export type BuilderPlanId = keyof typeof BUILDER_PLAN_MONTHLY_CENTS;

export function isBuilderPlanId(value: string): value is BuilderPlanId {
  return value in BUILDER_PLAN_MONTHLY_CENTS;
}

export function builderPlanAmountCents(planId: BuilderPlanId, annual: boolean): number {
  const monthly = BUILDER_PLAN_MONTHLY_CENTS[planId];
  return annual ? monthly * 10 : monthly;
}
