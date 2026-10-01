import { NextRequest, NextResponse } from 'next/server';
import { readBuilderSession } from '@/lib/auth/builder-session';

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
  console.log('[builder-auth-session] Authenticated Builder session', { userId: session.user.id });
  return NextResponse.json({ success: true, authenticated: true, user: session.user });
}
