import { NextRequest, NextResponse } from 'next/server';
import {
  BUILDER_SESSION_COOKIE,
  builderSessionCookieOptions,
} from '@/lib/auth/builder-session';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  console.log('[builder-auth-logout] Clearing Builder session cookie');
  const response = NextResponse.json({ success: true });
  response.cookies.set(BUILDER_SESSION_COOKIE, '', {
    ...builderSessionCookieOptions(request, 0),
    maxAge: 0,
  });
  return response;
}
