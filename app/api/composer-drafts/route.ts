import { NextRequest, NextResponse } from 'next/server';
import { readBuilderSession } from '@/lib/auth/builder-session';
import { parseComposerDraftWrite } from '@/lib/launch/composer-drafts';
import { launchWorkerFetch } from '@/lib/launch/worker-client';

export const dynamic = 'force-dynamic';

// ─── Ariadne's Thread [AT-0101] ─────────────────────
// What: Save the home composer text into the Builder sqlite database
// Why:  Visitors type before sign-in, and that text must not stay only in the browser
// Date: 2026-10-01
// Related: [AT-0099] shared→lib/launch/composer-drafts.ts:saveComposerDraft, [AT-0100] infra→cloudflare/launch-http.ts:routeLaunchRequest
// ─────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { id?: unknown; text?: unknown } | null;
  const session = await readBuilderSession(request);
  const userId = session.status === 'authenticated' ? session.user.id : null;
  const email = session.status === 'authenticated' ? session.user.email : null;
  const input = parseComposerDraftWrite({
    id: body?.id,
    text: body?.text,
    userId,
    email,
  });
  if (!input) {
    return NextResponse.json({ success: false, error: 'Invalid composer draft.' }, { status: 400 });
  }

  console.log('[composer-drafts] Saving home composer text', {
    id: input.id,
    textChars: input.text.length,
    hasUser: Boolean(input.userId),
    sessionStatus: session.status,
  });

  try {
    const response = await launchWorkerFetch('/composer-drafts', {
      method: 'POST',
      body: JSON.stringify(input),
    }, 8_000);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      console.error('[composer-drafts] Worker rejected composer draft', {
        id: input.id,
        status: response.status,
      });
      return NextResponse.json({ success: false, error: 'Composer text could not be saved.' }, { status: 502 });
    }
    console.log('[composer-drafts] Home composer text stored', { id: input.id, payload });
    return NextResponse.json(payload);
  } catch (error) {
    console.error('[composer-drafts] Worker request failed', {
      id: input.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Composer text could not be saved.' }, { status: 503 });
  }
}
