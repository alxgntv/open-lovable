import { NextRequest, NextResponse } from 'next/server';
import { codeMarketApiOrigin } from '@/lib/auth/builder-session';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@') || email.length > 320) {
      console.warn('[builder-auth-check-email] Rejected invalid email');
      return NextResponse.json({ success: false, error: 'Enter a valid email address.' }, { status: 400 });
    }
    const response = await fetch(`${codeMarketApiOrigin()}/api/auth/check-email/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as { allowed?: boolean; error?: string };
    console.log('[builder-auth-check-email] Code Market email check completed', {
      status: response.status,
      allowed: payload.allowed === true,
    });
    if (!response.ok || payload.allowed === false) {
      return NextResponse.json({
        success: false,
        error: payload.error || 'This email address cannot be used.',
      }, { status: response.ok ? 400 : response.status });
    }
    return NextResponse.json({ success: true, allowed: true });
  } catch (error) {
    console.error('[builder-auth-check-email] Email check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Email verification is temporarily unavailable.' }, { status: 503 });
  }
}
