import { NextRequest, NextResponse } from 'next/server';
import {
  BUILDER_SESSION_COOKIE,
  builderSessionCookieOptions,
  codeMarketApiOrigin,
} from '@/lib/auth/builder-session';

export const dynamic = 'force-dynamic';

interface ExchangePayload {
  token?: string;
  expires_in?: number;
  user?: {
    id?: number | string;
    email?: string;
    display_name?: string | null;
  };
  error?: string;
}

// ─── Ariadne's Thread [AT-0069] ─────────────────────
// What: Exchange a Firebase ID token for an HttpOnly Code Market Builder session
// Why:  The existing Code Market account system remains the source of truth and the bearer token never reaches browser JavaScript
// Date: 2026-09-30
// Related: [AT-0068] frontend→lib/auth/firebase.ts:signInBuilderWithGoogle, [AT-0071] lib/auth/builder-session.ts:readBuilderSession
// ─────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { idToken?: unknown };
    const idToken = typeof body.idToken === 'string' ? body.idToken.trim() : '';
    if (!idToken || idToken.length > 20_000) {
      console.warn('[builder-auth-exchange] Rejected request without a usable Firebase ID token');
      return NextResponse.json({ success: false, error: 'A Firebase sign-in token is required.' }, { status: 400 });
    }

    const startedAt = Date.now();
    const response = await fetch(`${codeMarketApiOrigin()}/api/auth/firebase/exchange/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ idToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({})) as ExchangePayload;
    console.log('[builder-auth-exchange] Code Market exchange completed', {
      status: response.status,
      durationMs: Date.now() - startedAt,
      hasToken: Boolean(payload.token),
      userId: payload.user?.id ?? null,
    });
    if (!response.ok || !payload.token || !payload.user?.id || !payload.user.email) {
      return NextResponse.json({
        success: false,
        error: payload.error || 'Code Market could not create a session.',
      }, { status: response.ok ? 502 : response.status });
    }

    const maxAge = Number.isFinite(payload.expires_in) && (payload.expires_in ?? 0) > 0
      ? Math.floor(payload.expires_in as number)
      : 60 * 60 * 24 * 30;
    const result = NextResponse.json({
      success: true,
      user: {
        id: String(payload.user.id),
        email: payload.user.email,
        displayName: payload.user.display_name || undefined,
      },
    });
    result.cookies.set(BUILDER_SESSION_COOKIE, payload.token, builderSessionCookieOptions(request, maxAge));
    return result;
  } catch (error) {
    console.error('[builder-auth-exchange] Exchange failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Code Market sign-in is temporarily unavailable.' }, { status: 503 });
  }
}
