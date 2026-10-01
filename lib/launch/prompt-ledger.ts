export interface StoredBuilderPrompt {
  id: string;
  runId: string;
  idempotencyKey: string;
  userId: string;
  email: string;
  prompt: string;
  model?: string;
  sourceUrl?: string;
  createdAt: string;
}

export interface PromptLedgerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list(options: {
    prefix: string;
    startAfter?: string;
    limit: number;
    reverse: boolean;
  }): Promise<Array<{ key: string; value: unknown }>>;
}

export interface InitialPromptInput {
  runId: string;
  idempotencyKey: string;
  userId: string;
  email: string;
  prompt: string;
  model?: string;
  sourceUrl?: string;
}

export class PromptLedgerConflict extends Error {
  readonly status = 409;
}

export class PromptOwnershipError extends Error {
  readonly status: 403 | 404;

  constructor(message: string, status: 403 | 404) {
    super(message);
    this.status = status;
  }
}

const PROMPT_PREFIX = 'prompt:';
const IDEMPOTENCY_PREFIX = 'idempotency:';
const RUN_PREFIX = 'run:';

interface RunOwner {
  userId: string;
  email: string;
  recordKey: string;
}

function samePrompt(existing: StoredBuilderPrompt, input: InitialPromptInput): boolean {
  return existing.runId === input.runId
    && existing.userId === input.userId
    && existing.email === input.email
    && existing.prompt === input.prompt
    && existing.model === input.model
    && existing.sourceUrl === input.sourceUrl;
}

// ─── Ariadne's Thread [AT-0076] ─────────────────────
// What: Persist the original Builder prompt before any model call and bind the run to one account
// Why:  Token-spending generation must be traceable to the Code Market user who started it, without duplicate records on retry
// Date: 2026-09-30
// Related: [AT-0075] infra→cloudflare/launch-http.ts:routeLaunchRequest, [AT-0072] backend→app/api/launch-runs/route.ts:POST
// ─────────────────────────────────────────────────────
export async function recordInitialPrompt(
  storage: PromptLedgerStorage,
  input: InitialPromptInput,
): Promise<StoredBuilderPrompt> {
  const idempotencyKey = `${IDEMPOTENCY_PREFIX}${input.idempotencyKey}`;
  const existingKey = await storage.get<string>(idempotencyKey);
  if (existingKey) {
    const existing = await storage.get<StoredBuilderPrompt>(existingKey);
    if (existing && samePrompt(existing, input)) {
      console.log('[prompt-ledger] Returning idempotent initial prompt', {
        runId: existing.runId,
        userId: existing.userId,
        promptChars: existing.prompt.length,
      });
      return existing;
    }
    console.warn('[prompt-ledger] Idempotency key was reused for a different prompt', {
      runId: input.runId,
      userId: input.userId,
    });
    throw new PromptLedgerConflict('Idempotency key already belongs to another Builder request');
  }

  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const recordKey = `${PROMPT_PREFIX}${createdAt}:${id}`;
  const record: StoredBuilderPrompt = {
    id,
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    userId: input.userId,
    email: input.email,
    prompt: input.prompt,
    model: input.model,
    sourceUrl: input.sourceUrl,
    createdAt,
  };
  await storage.put(recordKey, record);
  await storage.put(idempotencyKey, recordKey);
  await storage.put(`${RUN_PREFIX}${input.runId}`, {
    userId: input.userId,
    email: input.email,
    recordKey,
  } satisfies RunOwner);
  console.log('[prompt-ledger] Initial prompt stored', {
    runId: input.runId,
    userId: input.userId,
    promptChars: input.prompt.length,
    hasSourceUrl: Boolean(input.sourceUrl),
  });
  return record;
}

export async function assertPromptOwner(
  storage: PromptLedgerStorage,
  runId: string,
  userId: string,
): Promise<void> {
  const owner = await storage.get<RunOwner>(`${RUN_PREFIX}${runId}`);
  if (!owner) {
    console.warn('[prompt-ledger] Revision rejected because the run has no stored owner', { runId, userId });
    throw new PromptOwnershipError('Launch run has no saved owner', 404);
  }
  if (owner.userId !== userId) {
    console.warn('[prompt-ledger] Revision rejected for another account', {
      runId,
      userId,
      ownerUserId: owner.userId,
    });
    throw new PromptOwnershipError('Launch run belongs to another Code Market account', 403);
  }
  console.log('[prompt-ledger] Run owner confirmed', { runId, userId });
}

export async function listStoredPrompts(
  storage: PromptLedgerStorage,
  cursor: string | undefined,
  limit: number,
): Promise<{ prompts: StoredBuilderPrompt[]; nextCursor: string | null }> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit) || 50));
  const rows = await storage.list({
    prefix: PROMPT_PREFIX,
    startAfter: cursor,
    limit: boundedLimit + 1,
    reverse: true,
  });
  const page = rows.slice(0, boundedLimit);
  console.log('[prompt-ledger] Listed stored prompts', {
    count: page.length,
    hasMore: rows.length > boundedLimit,
  });
  return {
    prompts: page.map((row) => row.value as StoredBuilderPrompt),
    nextCursor: rows.length > boundedLimit ? page[page.length - 1]?.key ?? null : null,
  };
}

export class MemoryPromptLedger implements PromptLedgerStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async list(options: {
    prefix: string;
    startAfter?: string;
    limit: number;
    reverse: boolean;
  }): Promise<Array<{ key: string; value: unknown }>> {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix))
      .sort((left, right) => left.localeCompare(right));
    const ordered = options.reverse ? keys.reverse() : keys;
    const startIndex = options.startAfter
      ? ordered.findIndex((key) => key === options.startAfter) + 1
      : 0;
    return ordered.slice(Math.max(0, startIndex), Math.max(0, startIndex) + options.limit)
      .map((key) => ({ key, value: this.values.get(key) }));
  }
}
