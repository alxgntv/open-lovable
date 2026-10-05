import { describe, expect, it } from 'vitest';
import {
  listBuilderOrders,
  parseBuilderOrderWrite,
  saveBuilderOrder,
} from '../../lib/launch/builder-orders';
import type { ComposerDraftSql } from '../../lib/launch/composer-drafts';

class MemoryOrderSql implements ComposerDraftSql {
  rows: Array<Record<string, string | number | null>> = [];

  exec(query: string, ...bindings: Array<string | number | null>) {
    const sql = query.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('CREATE TABLE')) return [];
    if (sql.startsWith('INSERT')) {
      const [id, userId, email, planId, interval, amountCents, currency, status, createdAt] = bindings;
      this.rows.push({
        id: String(id),
        user_id: String(userId),
        email: String(email),
        plan_id: String(planId),
        interval: String(interval),
        amount_cents: Number(amountCents),
        currency: String(currency),
        status: String(status),
        created_at: String(createdAt),
      });
      return [];
    }
    if (sql.startsWith('SELECT id')) {
      const limit = Number(bindings[0]);
      return [...this.rows].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))).slice(0, limit);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

describe('builder orders sqlite', () => {
  it('rejects an unknown plan and a missing account', () => {
    expect(parseBuilderOrderWrite({ userId: '42', email: 'a@b.co', planId: 'nope', annual: false })).toBeNull();
    expect(parseBuilderOrderWrite({ userId: 'abc', email: 'a@b.co', planId: 'membership', annual: false })).toBeNull();
  });

  it('stores the published price for a new pending order', () => {
    const sql = new MemoryOrderSql();
    const order = saveBuilderOrder(sql, {
      userId: '111776',
      email: 'person@example.com',
      planId: 'credits-350',
      annual: true,
    });
    expect(order.amountCents).toBe(3800 * 10);
    expect(order.interval).toBe('year');
    expect(order.status).toBe('pending');
    const listed = listBuilderOrders(sql, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.userId).toBe('111776');
    expect(listed[0]?.planId).toBe('credits-350');
  });
});
