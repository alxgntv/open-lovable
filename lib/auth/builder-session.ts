import 'server-only';

import { createHash, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  decideLaunchBuilderAccess,
  decidePaidBuilderAccess,
  type BuilderAccessDecision,
  type BuilderSessionRead,
  type BuilderSessionUser,
} from './access-policy';

export const BUILDER_SESSION_COOKIE = 'cm_builder_session';
export const BUILDER_INTERNAL_HEADER = 'x-builder-internal-auth';
export const CODE_MARKET_USER_ID_HEADER = 'x-code-market-user-id';
export const CODE_MARKET_USER_EMAIL_HEADER = 'x-code-market-user-email';

const PROFILE_CACHE_TTL_MS = 60_000;
const profileCache = new Map<string, { expiresAt: number; user: BuilderSessionUser }>();

interface CodeMarketProfile {
  user?: {
    id?: number | string;
    email?: string;
    display_name?: string | null;
  };
}

const PAID_PLAN_FLAGS = ['paid_plan', 'has_paid_plan', 'is_paid', 'subscription_active'] as const;

// ─── Ariadne's Thread [AT-0092] ─────────────────────
// What: Read a paid-plan flag from the Code Market profile when one is present
// Why:  Builder actions need to tell a signed-in account from an account with a paid tariff
// Date: 2026-10-01
// Related: [AT-0071] lib/auth/builder-session.ts:readProfile, [AT-0093] frontend→components/app/home/BuilderPaywall.tsx:BuilderPaywall
// ─────────────────────────────────────────────────────
function profileHasPaidPlan(user: NonNullable<CodeMarketProfile['user']>): boolean {
  const record = user as Record<string, unknown>;
  const present = PAID_PLAN_FLAGS.filter((key) => typeof record[key] === 'boolean');
  const paid = present.some((key) => record[key] === true);
  console.log('[builder-session] Paid plan flags on profile', {
    paid,
    flagCount: present.length,
    keys: Object.keys(user),
  });
  return paid;
}

export function codeMarketApiOrigin(): string {
  return (process.env.CODE_MARKET_API_ORIGIN || 'https://code.market').replace(/\/$/, '');
}

export function builderSessionCookieOptions(request: NextRequest, maxAge: number) {
  const secure = request.nextUrl.protocol === 'https:';
  console.log('[builder-session] Cookie options selected', { secure, maxAge });
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

function tokenCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function internalBuilderRequest(request: NextRequest): boolean {
  const expected = process.env.BUILDER_INTERNAL_SECRET || '';
  const provided = request.headers.get(BUILDER_INTERNAL_HEADER) || '';
  if (!expected || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

async function readProfile(token: string): Promise<BuilderSessionRead> {
  const cacheKey = tokenCacheKey(token);
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[builder-session] Using cached Code Market profile', {
      userId: cached.user.id,
      cacheKeyPrefix: cacheKey.slice(0, 12),
    });
    return { status: 'authenticated', user: cached.user };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(`${codeMarketApiOrigin()}/api/products/profile/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    console.log('[builder-session] Code Market profile response', {
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    if (response.status === 401 || response.status === 403) {
      profileCache.delete(cacheKey);
      return { status: 'anonymous' };
    }
    if (!response.ok) return { status: 'unavailable' };
    const payload = await response.json() as CodeMarketProfile;
    const id = String(payload.user?.id ?? '');
    const email = payload.user?.email?.trim().toLowerCase() || '';
    if (!/^\d+$/.test(id) || !email.includes('@')) {
      console.error('[builder-session] Code Market profile did not include a usable user', {
        hasId: Boolean(id),
        hasEmail: Boolean(email),
      });
      return { status: 'anonymous' };
    }
    const user: BuilderSessionUser = {
      id,
      email,
      displayName: payload.user?.display_name?.trim() || undefined,
      paidPlan: payload.user ? profileHasPaidPlan(payload.user) : false,
    };
    profileCache.set(cacheKey, { expiresAt: Date.now() + PROFILE_CACHE_TTL_MS, user });
    return { status: 'authenticated', user };
  } catch (error) {
    console.error('[builder-session] Code Market profile request failed', {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable' };
  }
}

// ─── Ariadne's Thread [AT-0071] ─────────────────────
// What: Resolve the Builder cookie through the existing Code Market profile endpoint
// Why:  The browser must not receive or replay the Code Market bearer token, and paid work needs a verified user
// Date: 2026-09-30
// Related: [AT-0070] lib/auth/access-policy.ts:decidePaidBuilderAccess, [AT-0069] app/api/auth/exchange/route.ts:POST
// ─────────────────────────────────────────────────────
export async function readBuilderSession(request: NextRequest): Promise<BuilderSessionRead> {
  const token = request.cookies.get(BUILDER_SESSION_COOKIE)?.value || '';
  if (!token) {
    console.log('[builder-session] No Builder session cookie');
    return { status: 'anonymous' };
  }
  return readProfile(token);
}

export async function rejectUnauthenticatedPaidRequest(request: NextRequest): Promise<NextResponse | null> {
  const decision = await authorizePaidBuilderRequest(request);
  return decision instanceof NextResponse ? decision : null;
}

export async function authorizePaidBuilderRequest(
  request: NextRequest,
): Promise<BuilderAccessDecision | NextResponse> {
  const decision = decidePaidBuilderAccess({
    internal: internalBuilderRequest(request),
    session: internalBuilderRequest(request)
      ? { status: 'anonymous' }
      : await readBuilderSession(request),
  });
  return accessResponse(request, decision);
}

export async function requireCodeMarketUser(
  request: NextRequest,
): Promise<BuilderSessionUser | NextResponse> {
  const decision = decideLaunchBuilderAccess(await readBuilderSession(request));
  if (!decision.allow || decision.actor !== 'user') {
    const response = accessResponse(request, decision);
    return response instanceof NextResponse
      ? response
      : NextResponse.json({ success: false, error: 'Sign in to Code Market before using Builder.' }, { status: 401 });
  }
  console.log('[builder-session] Code Market user authorized for launch', {
    userId: decision.user.id,
    path: request.nextUrl.pathname,
  });
  return decision.user;
}

function accessResponse(
  request: NextRequest,
  decision: BuilderAccessDecision,
): BuilderAccessDecision | NextResponse {
  if (decision.allow) {
    console.log('[builder-session] Paid Builder request authorized', {
      actor: decision.actor,
      userId: decision.actor === 'user' ? decision.user.id : undefined,
      path: request.nextUrl.pathname,
    });
    return decision;
  }
  console.warn('[builder-session] Paid Builder request rejected', {
    status: decision.status,
    path: request.nextUrl.pathname,
  });
  return NextResponse.json({ success: false, error: decision.error }, { status: decision.status });
}

export function codeMarketUserHeaders(user: BuilderSessionUser): Record<string, string> {
  return {
    [CODE_MARKET_USER_ID_HEADER]: user.id,
    [CODE_MARKET_USER_EMAIL_HEADER]: encodeURIComponent(user.email),
  };
}
