import { builderPlanAmountCents, isBuilderPlanId, type BuilderPlanId } from '../billing/builder-plans';
import type { ComposerDraftSql } from './composer-drafts';

export interface BuilderOrderRecord {
  id: string;
  userId: string;
  email: string;
  planId: BuilderPlanId;
  interval: 'month' | 'year';
  amountCents: number;
  currency: 'usd';
  status: 'pending';
  createdAt: string;
}

export interface BuilderOrderWrite {
  userId: string;
  email: string;
  planId: string;
  annual: boolean;
}

function textValue(value: string | number | null | undefined): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

// ─── Ariadne's Thread [AT-0105] ─────────────────────
// What: Insert each Choose click into the Builder sqlite orders table
// Why:  Pending plan orders must be readable in the same database as composer drafts
// Date: 2026-10-05
// Related: [AT-0096] backend→app/api/builder-orders/route.ts:POST, [AT-0099] shared→lib/launch/composer-drafts.ts:saveComposerDraft
// ─────────────────────────────────────────────────────
export function parseBuilderOrderWrite(body: unknown): BuilderOrderWrite | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
  const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
  const planId = typeof record.planId === 'string' ? record.planId : '';
  const annual = record.annual === true;
  if (!/^\d+$/.test(userId) || !email.includes('@') || email.length > 320 || !isBuilderPlanId(planId)) {
    console.warn('[builder-orders] Rejected order write', {
      hasUser: Boolean(userId),
      validUser: /^\d+$/.test(userId),
      hasEmail: email.includes('@'),
      planId,
    });
    return null;
  }
  return { userId, email, planId, annual };
}

export function ensureBuilderOrdersTable(sql: ComposerDraftSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS builder_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    interval TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

export function saveBuilderOrder(sql: ComposerDraftSql, input: BuilderOrderWrite): BuilderOrderRecord {
  ensureBuilderOrdersTable(sql);
  if (!isBuilderPlanId(input.planId)) {
    throw new Error('Unknown builder plan');
  }
  const order: BuilderOrderRecord = {
    id: `ord_${crypto.randomUUID()}`,
    userId: input.userId,
    email: input.email,
    planId: input.planId,
    interval: input.annual ? 'year' : 'month',
    amountCents: builderPlanAmountCents(input.planId, input.annual),
    currency: 'usd',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  sql.exec(
    'INSERT INTO builder_orders (id, user_id, email, plan_id, interval, amount_cents, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    order.id,
    order.userId,
    order.email,
    order.planId,
    order.interval,
    order.amountCents,
    order.currency,
    order.status,
    order.createdAt,
  );
  console.log('[builder-orders] Pending order stored in sqlite', {
    orderId: order.id,
    userId: order.userId,
    planId: order.planId,
    interval: order.interval,
    amountCents: order.amountCents,
  });
  return order;
}

export function listBuilderOrders(sql: ComposerDraftSql, limit: number): BuilderOrderRecord[] {
  ensureBuilderOrdersTable(sql);
  const bounded = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 50;
  const rows = sql.exec(
    'SELECT id, user_id, email, plan_id, interval, amount_cents, currency, status, created_at FROM builder_orders ORDER BY created_at DESC LIMIT ?',
    bounded,
  );
  const orders = [...rows].flatMap((row) => {
    const planId = textValue(row.plan_id);
    const interval = textValue(row.interval);
    const status = textValue(row.status);
    const currency = textValue(row.currency);
    if (!isBuilderPlanId(planId) || (interval !== 'month' && interval !== 'year') || status !== 'pending' || currency !== 'usd') {
      console.warn('[builder-orders] Skipping unreadable order row', { id: textValue(row.id), planId, interval, status });
      return [];
    }
    return [{
      id: textValue(row.id),
      userId: textValue(row.user_id),
      email: textValue(row.email),
      planId,
      interval,
      amountCents: Number(row.amount_cents),
      currency,
      status,
      createdAt: textValue(row.created_at),
    } satisfies BuilderOrderRecord];
  });
  console.log('[builder-orders] Listed sqlite orders', { count: orders.length, limit: bounded });
  return orders;
}
