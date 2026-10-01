import { describe, expect, it } from 'vitest';
import {
  listComposerDrafts,
  parseComposerDraftWrite,
  saveComposerDraft,
  type ComposerDraftSql,
} from '../../lib/launch/composer-drafts';

class MemoryComposerSql implements ComposerDraftSql {
  private rows = new Map<string, Record<string, string | null>>();

  exec(query: string, ...bindings: Array<string | number | null>) {
    const sql = query.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('CREATE TABLE')) return [];
    if (sql.startsWith('SELECT created_at')) {
      const row = this.rows.get(String(bindings[0]));
      return row ? [{ created_at: row.created_at }] : [];
    }
    if (sql.startsWith('INSERT')) {
      const [id, text, userId, email, createdAt, updatedAt] = bindings.map((value) => (
        value === null ? null : String(value)
      ));
      this.rows.set(String(id), {
        id: String(id),
        text: String(text),
        user_id: userId,
        email,
        created_at: String(createdAt),
        updated_at: String(updatedAt),
      });
      return [];
    }
    if (sql.startsWith('UPDATE')) {
      const [text, userId, email, updatedAt, id] = bindings;
      const row = this.rows.get(String(id));
      if (!row) return [];
      row.text = String(text);
      row.user_id = userId === null ? row.user_id : String(userId);
      row.email = email === null ? row.email : String(email);
      row.updated_at = String(updatedAt);
      return [];
    }
    if (sql.startsWith('SELECT id')) {
      const limit = Number(bindings[0]);
      return [...this.rows.values()]
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
        .slice(0, limit);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

const draftId = '6f1e5c3a-8b2d-4c7e-9a1b-2d4e6f8a0c1d';

describe('composer drafts', () => {
  it('rejects an invalid id and an oversized prompt', () => {
    expect(parseComposerDraftWrite({ id: 'nope', text: 'hello' })).toBeNull();
    expect(parseComposerDraftWrite({ id: draftId, text: 'x'.repeat(32_001) })).toBeNull();
  });

  it('upserts one sqlite row for the same browser draft', () => {
    const sql = new MemoryComposerSql();
    const first = saveComposerDraft(sql, {
      id: draftId,
      text: 'An app that invoices',
      userId: null,
      email: null,
    });
    const second = saveComposerDraft(sql, {
      id: draftId,
      text: 'An app that invoices clients',
      userId: '42',
      email: 'builder@code.market',
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.text).toBe('An app that invoices clients');
    expect(second.userId).toBe('42');
    const listed = listComposerDrafts(sql, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.text).toBe('An app that invoices clients');
  });
});
