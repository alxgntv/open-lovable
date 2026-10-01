import { describe, expect, it } from 'vitest';
import {
  MemoryPromptLedger,
  PromptLedgerConflict,
  PromptOwnershipError,
  assertPromptOwner,
  listStoredPrompts,
  recordInitialPrompt,
} from '../../lib/launch/prompt-ledger';
import { parsePendingBuilderRequest } from '../../lib/auth/pending-request';

const input = {
  runId: 'lr-promptledger0001',
  idempotencyKey: 'same-request',
  userId: '42',
  email: 'builder@code.market',
  prompt: 'free pdf builder',
  model: 'openai/gpt-5.6-sol',
};

// ─── Ariadne's Thread [AT-0080] ─────────────────────
// What: Verify first-prompt idempotency, account ownership, and pending-request restore
// Why:  Retries must not duplicate the saved starting point, and another account must not continue the run
// Date: 2026-09-30
// Related: [AT-0076] shared→lib/launch/prompt-ledger.ts:recordInitialPrompt, [AT-0074] frontend→app/generation/page.tsx:sendChatMessage
// ─────────────────────────────────────────────────────
describe('builder prompt ledger', () => {
  it('stores the original prompt once and returns the same record for an exact retry', async () => {
    const storage = new MemoryPromptLedger();
    const first = await recordInitialPrompt(storage, input);
    const second = await recordInitialPrompt(storage, input);
    expect(second).toEqual(first);
    const page = await listStoredPrompts(storage, undefined, 50);
    expect(page.prompts).toHaveLength(1);
    expect(page.prompts[0]?.prompt).toBe('free pdf builder');
  });

  it('rejects reuse of an idempotency key for a different prompt', async () => {
    const storage = new MemoryPromptLedger();
    await recordInitialPrompt(storage, input);
    await expect(recordInitialPrompt(storage, { ...input, prompt: 'different' }))
      .rejects.toBeInstanceOf(PromptLedgerConflict);
  });

  it('rejects revisions from another account and missing runs', async () => {
    const storage = new MemoryPromptLedger();
    await recordInitialPrompt(storage, input);
    await expect(assertPromptOwner(storage, input.runId, '42')).resolves.toBeUndefined();
    await expect(assertPromptOwner(storage, input.runId, '7')).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<PromptOwnershipError>);
    await expect(assertPromptOwner(storage, 'lr-missing', '42')).rejects.toMatchObject({ status: 404 });
  });

  it('paginates newest stored prompts first', async () => {
    const storage = new MemoryPromptLedger();
    await recordInitialPrompt(storage, input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordInitialPrompt(storage, {
      ...input,
      runId: 'lr-promptledger0002',
      idempotencyKey: 'second-request',
      prompt: 'second',
    });
    const page = await listStoredPrompts(storage, undefined, 1);
    expect(page.prompts.map((prompt) => prompt.prompt)).toEqual(['second']);
    expect(page.nextCursor).toBeTruthy();
    const rest = await listStoredPrompts(storage, page.nextCursor ?? undefined, 1);
    expect(rest.prompts.map((prompt) => prompt.prompt)).toEqual(['free pdf builder']);
  });

  it('restores only complete pending chat and URL requests', () => {
    expect(parsePendingBuilderRequest(JSON.stringify({
      kind: 'chat',
      prompt: '  free pdf builder  ',
      savedAt: '2026-09-30T00:00:00.000Z',
    }))?.prompt).toBe('free pdf builder');
    expect(parsePendingBuilderRequest('{"kind":"url"}')).toBeNull();
    expect(parsePendingBuilderRequest('not-json')).toBeNull();
  });
});