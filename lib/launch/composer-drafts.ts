export const COMPOSER_DRAFT_TEXT_LIMIT = 32_000;

const DRAFT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ComposerDraftSql {
  exec(
    query: string,
    ...bindings: Array<string | number | null>
  ): Iterable<Record<string, string | number | null>>;
}

export interface ComposerDraftRecord {
  id: string;
  text: string;
  userId: string | null;
  email: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComposerDraftWrite {
  id: string;
  text: string;
  userId: string | null;
  email: string | null;
}

function textValue(value: string | number | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: string | number | null | undefined): string | null {
  return typeof value === 'string' && value ? value : null;
}

// ─── Ariadne's Thread [AT-0099] ─────────────────────
// What: Validate and upsert the home composer text in the Builder sqlite table
// Why:  Typed requests must be stored in the database before sign-in, one row per browser draft
// Date: 2026-10-01
// Related: [AT-0094] frontend→components/app/home/ProjectHome.tsx:writeComposerDraft, [AT-0078] cloudflare/builder-prompt-store.ts:BuilderPromptStore
// ─────────────────────────────────────────────────────
export function parseComposerDraftWrite(body: unknown): ComposerDraftWrite | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const text = typeof record.text === 'string' ? record.text : null;
  const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
  const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
  if (!DRAFT_ID_PATTERN.test(id) || text === null || text.length > COMPOSER_DRAFT_TEXT_LIMIT) {
    console.warn('[composer-drafts] Rejected draft write', {
      hasId: Boolean(id),
      validId: DRAFT_ID_PATTERN.test(id),
      textChars: text?.length ?? null,
    });
    return null;
  }
  const account = /^\d+$/.test(userId) && email.includes('@') && email.length <= 320;
  return {
    id,
    text,
    userId: account ? userId : null,
    email: account ? email : null,
  };
}

export function ensureComposerDraftTable(sql: ComposerDraftSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS composer_drafts (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    user_id TEXT,
    email TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

export function saveComposerDraft(sql: ComposerDraftSql, input: ComposerDraftWrite): ComposerDraftRecord {
  ensureComposerDraftTable(sql);
  const now = new Date().toISOString();
  const existing = [...sql.exec('SELECT created_at FROM composer_drafts WHERE id = ?', input.id)];
  const createdAt = textValue(existing[0]?.created_at) || now;
  if (existing.length === 0) {
    sql.exec(
      'INSERT INTO composer_drafts (id, text, user_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      input.id,
      input.text,
      input.userId,
      input.email,
      createdAt,
      now,
    );
    console.log('[composer-drafts] Inserted composer draft', {
      id: input.id,
      textChars: input.text.length,
      hasUser: Boolean(input.userId),
    });
  } else {
    sql.exec(
      'UPDATE composer_drafts SET text = ?, user_id = COALESCE(?, user_id), email = COALESCE(?, email), updated_at = ? WHERE id = ?',
      input.text,
      input.userId,
      input.email,
      now,
      input.id,
    );
    console.log('[composer-drafts] Updated composer draft', {
      id: input.id,
      textChars: input.text.length,
      hasUser: Boolean(input.userId),
    });
  }
  return {
    id: input.id,
    text: input.text,
    userId: input.userId,
    email: input.email,
    createdAt,
    updatedAt: now,
  };
}

export function listComposerDrafts(
  sql: ComposerDraftSql,
  limit: number,
): ComposerDraftRecord[] {
  ensureComposerDraftTable(sql);
  const bounded = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 50;
  const rows = sql.exec(
    'SELECT id, text, user_id, email, created_at, updated_at FROM composer_drafts ORDER BY updated_at DESC LIMIT ?',
    bounded,
  );
  const drafts = [...rows].map((row) => ({
    id: textValue(row.id),
    text: textValue(row.text),
    userId: optionalText(row.user_id),
    email: optionalText(row.email),
    createdAt: textValue(row.created_at),
    updatedAt: textValue(row.updated_at),
  }));
  console.log('[composer-drafts] Listed composer drafts', { count: drafts.length, limit: bounded });
  return drafts;
}
