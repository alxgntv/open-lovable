export interface BuilderSessionUser {
  id: string;
  email: string;
  displayName?: string;
  paidPlan?: boolean;
}

export type BuilderSessionRead =
  | { status: 'authenticated'; user: BuilderSessionUser }
  | { status: 'anonymous' }
  | { status: 'unavailable' };

export type BuilderAccessDecision =
  | { allow: true; actor: 'internal' }
  | { allow: true; actor: 'user'; user: BuilderSessionUser }
  | { allow: false; status: 401 | 503; error: string };

// ─── Ariadne's Thread [AT-0070] ─────────────────────
// What: Decide whether a paid Builder request may proceed
// Why:  UI checks cannot stop direct API calls, while internal Worker retries must not be treated as anonymous users
// Date: 2026-09-30
// Related: [AT-0071] backend→lib/auth/builder-session.ts:readBuilderSession, [AT-0072] backend→app/api/launch-runs/route.ts:POST
// ─────────────────────────────────────────────────────
export function decidePaidBuilderAccess(input: {
  internal: boolean;
  session: BuilderSessionRead;
}): BuilderAccessDecision {
  if (input.internal) return { allow: true, actor: 'internal' };
  if (input.session.status === 'unavailable') {
    return { allow: false, status: 503, error: 'Code Market sign-in is temporarily unavailable.' };
  }
  if (input.session.status === 'anonymous') {
    return { allow: false, status: 401, error: 'Sign in to Code Market before using Builder.' };
  }
  return { allow: true, actor: 'user', user: input.session.user };
}

export function decideLaunchBuilderAccess(session: BuilderSessionRead): BuilderAccessDecision {
  if (session.status === 'unavailable') {
    return { allow: false, status: 503, error: 'Code Market sign-in is temporarily unavailable.' };
  }
  if (session.status === 'anonymous') {
    return { allow: false, status: 401, error: 'Sign in to Code Market before using Builder.' };
  }
  return { allow: true, actor: 'user', user: session.user };
}
