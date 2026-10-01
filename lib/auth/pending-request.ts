export const PENDING_BUILDER_REQUEST_KEY = 'builderPendingRequest';

export type PendingBuilderRequest =
  | {
    kind: 'chat';
    prompt: string;
    model?: string;
    savedAt: string;
  }
  | {
    kind: 'url';
    url: string;
    context?: string;
    style?: string;
    model?: string;
    savedAt: string;
  };

export function serializePendingBuilderRequest(request: PendingBuilderRequest): string {
  return JSON.stringify(request);
}

export function parsePendingBuilderRequest(value: string | null): PendingBuilderRequest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PendingBuilderRequest>;
    if (parsed.kind === 'chat' && typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
      return {
        kind: 'chat',
        prompt: parsed.prompt.trim(),
        model: typeof parsed.model === 'string' ? parsed.model : undefined,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      };
    }
    if (parsed.kind === 'url' && typeof parsed.url === 'string' && parsed.url.trim()) {
      return {
        kind: 'url',
        url: parsed.url.trim(),
        context: typeof parsed.context === 'string' ? parsed.context : undefined,
        style: typeof parsed.style === 'string' ? parsed.style : undefined,
        model: typeof parsed.model === 'string' ? parsed.model : undefined,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      };
    }
  } catch (error) {
    console.error('[builder-pending-request] Stored request is invalid', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}
