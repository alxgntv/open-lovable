import { DurableObject } from 'cloudflare:workers';
import {
  assertPromptOwner,
  listStoredPrompts,
  recordInitialPrompt,
  type InitialPromptInput,
  type PromptLedgerStorage,
  type StoredBuilderPrompt,
} from '../lib/launch/prompt-ledger';

// ─── Ariadne's Thread [AT-0078] ─────────────────────
// What: Store every original Builder prompt in one durable ledger
// Why:  The first request must survive Worker restarts and remain queryable without a database write
// Date: 2026-09-30
// Related: [AT-0076] shared→lib/launch/prompt-ledger.ts:recordInitialPrompt, [AT-0075] cloudflare/launch-http.ts:routeLaunchRequest
// ─────────────────────────────────────────────────────
export class BuilderPromptStore extends DurableObject {
  async recordInitial(input: InitialPromptInput): Promise<StoredBuilderPrompt> {
    return recordInitialPrompt(this.storage(), input);
  }

  async assertOwner(runId: string, userId: string): Promise<void> {
    await assertPromptOwner(this.storage(), runId, userId);
  }

  async list(cursor: string | undefined, limit: number): Promise<{
    prompts: StoredBuilderPrompt[];
    nextCursor: string | null;
  }> {
    return listStoredPrompts(this.storage(), cursor, limit);
  }

  private storage(): PromptLedgerStorage {
    return {
      get: async <T>(key: string) => this.ctx.storage.get<T>(key),
      put: async (key: string, value: unknown) => {
        await this.ctx.storage.put(key, value);
      },
      list: async (options) => {
        const rows = await this.ctx.storage.list({
          prefix: options.prefix,
          startAfter: options.startAfter,
          limit: options.limit,
          reverse: options.reverse,
        });
        return [...rows.entries()].map(([key, value]) => ({ key, value }));
      },
    };
  }
}
