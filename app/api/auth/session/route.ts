import { NextRequest, NextResponse } from 'next/server';
import { readBuilderSession } from '@/lib/auth/builder-session';
import { launchWorkerFetch } from '@/lib/launch/worker-client';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await readBuilderSession(request);
  if (session.status === 'unavailable') {
    console.error('[builder-auth-session] Code Market session could not be verified');
    return NextResponse.json({
      success: false,
      error: 'Code Market sign-in is temporarily unavailable.',
    }, { status: 503 });
  }
  if (session.status === 'anonymous') {
    console.log('[builder-auth-session] Anonymous Builder session');
    return NextResponse.json({ success: true, authenticated: false, user: null });
  }
  let user = session.user;
  if (user.paidPlan !== true) {
    try {
      const paidResponse = await launchWorkerFetch(`/builder-orders?userId=${encodeURIComponent(user.id)}`, { method: 'GET' }, 8_000);
      const paidPayload = await paidResponse.json().catch(() => null) as { paid?: boolean } | null;
      if (paidResponse.ok && paidPayload?.paid === true) {
        user = { ...user, paidPlan: true };
        console.log('[builder-auth-session] Paid builder order unlocks the paywall', { userId: user.id });
      }
    } catch (error) {
      console.error('[builder-auth-session] Paid order lookup failed', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  console.log('[builder-auth-session] Authenticated Builder session', { userId: user.id, paidPlan: user.paidPlan === true });
  return NextResponse.json({ success: true, authenticated: true, user });
}
