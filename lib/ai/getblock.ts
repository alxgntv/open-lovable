import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

export const GETBLOCK_DEFAULT_BASE_URL = 'https://inference.eu-central-1.getblock.io';

export type GetBlockApiFormat =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export interface GetBlockModel {
  id: string;
  name: string;
  supportedApis: GetBlockApiFormat[];
  maxCompletionTokens: number | null;
}

interface GetBlockCatalogCache {
  fetchedAt: number;
  models: GetBlockModel[];
}

let catalogCache: GetBlockCatalogCache | null = null;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const INFERENCE_TIMEOUT_MS = 5 * 60 * 1000;

function getGetBlockApiKey(): string {
  const apiKey = process.env.GETBLOCK_API_KEY?.trim();
  if (!apiKey) {
    console.error('[getblock] GETBLOCK_API_KEY is missing');
    throw new Error('GETBLOCK_API_KEY is not configured');
  }
  return apiKey;
}

export function getGetBlockBaseUrl(): string {
  const baseUrl = (process.env.GETBLOCK_INFERENCE_BASE_URL || GETBLOCK_DEFAULT_BASE_URL).replace(/\/$/, '');
  console.log('[getblock] Using inference base URL:', baseUrl);
  return baseUrl;
}

function readMaxCompletionTokens(row: any): number | null {
  const value = row?.top_provider?.max_completion_tokens;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return null;
}

// ─── Ariadne's Thread [AT-0015] ─────────────────────
// What: Set max_tokens from the selected model's catalog limit
// Why:  GetBlock publishes a different max_completion_tokens for each model
// Date: 2026-09-30
// Related: [AT-0006] app/api/generate-ai-code-stream/route.ts, [AT-0013] lib/ai/getblock.ts:getBlockFetch
// ─────────────────────────────────────────────────────
async function getBlockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // ─── Ariadne's Thread [AT-0042] ─────────────────────
  // What: Bound every GetBlock inference request with an abort timeout
  // Why:  Durable recovery cannot classify or escalate an upstream call that never settles
  // Date: 2026-09-30
  // Related: [AT-0036] lib/ai/launch-generation-service.ts:generateLaunchArtifactText, [AT-0040] infra→cloudflare/launch-run.ts:advanceRecovery
  // ─────────────────────────────────────────────────────
  // ─── Ariadne's Thread [AT-0063] ─────────────────────
  // What: Preserve a five-minute inference deadline while normalizing GetBlock request bodies
  // Why:  Body rewrites dropped the timeout signal, while a verified compact GPT-5.6-Sol artifact needs more than three minutes
  // Date: 2026-09-30
  // Related: [AT-0042] lib/ai/getblock.ts:getBlockFetch, [AT-0062] lib/ai/launch-generation-service.ts:generationSystemPrompt
  // ─────────────────────────────────────────────────────
  let nextInit: RequestInit = {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(INFERENCE_TIMEOUT_MS)])
      : AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
  };
  let requestModel = '';
  const rawBody = init?.body;
  if (typeof rawBody === 'string') {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      requestModel = typeof parsed.model === 'string' ? parsed.model : '';
      let changed = false;
      const modelLimit = await getGetBlockMaxCompletionTokens(requestModel);
      if (modelLimit && parsed.max_tokens !== modelLimit) {
        console.log('[getblock] Applying model max_completion_tokens', {
          model: parsed.model,
          from: parsed.max_tokens ?? null,
          to: modelLimit,
        });
        parsed.max_tokens = modelLimit;
        changed = true;
      }
      if (!modelLimit) {
        console.error('[getblock] Catalog has no max_completion_tokens for model', parsed.model);
      }
      if (Array.isArray(parsed.stop) && parsed.stop.length === 0) {
        delete parsed.stop;
        changed = true;
        console.log('[getblock] Removed empty stop list', { model: parsed.model });
      }
      if (changed) {
        nextInit = { ...nextInit, body: JSON.stringify(parsed) };
      }
    } catch (error) {
      console.error('[getblock] Failed to inspect outgoing request body:', error);
    }
  }
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const startedAt = Date.now();
  console.log('[getblock] Opening inference request', {
    model: requestModel || null,
    url: requestUrl,
    timeoutMs: INFERENCE_TIMEOUT_MS,
    hasCallerSignal: Boolean(init?.signal),
  });
  try {
    const response = await fetch(input, nextInit);
    console.log('[getblock] Inference response headers received', {
      model: requestModel || null,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    console.error('[getblock] Inference request failed before response completion', {
      model: requestModel || null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function getGetBlockChatClient() {
  const apiKey = getGetBlockApiKey();
  const baseURL = `${getGetBlockBaseUrl()}/openai-chat-completions/v1`;
  console.log('[getblock] Creating OpenAI chat client', { baseURL, hasApiKey: true });
  return createOpenAI({ apiKey, baseURL, name: 'getblock', fetch: getBlockFetch });
}

export function getGetBlockResponsesClient() {
  const apiKey = getGetBlockApiKey();
  const baseURL = `${getGetBlockBaseUrl()}/openai-responses/v1`;
  console.log('[getblock] Creating OpenAI responses client', { baseURL, hasApiKey: true });
  return createOpenAI({ apiKey, baseURL, name: 'getblock', fetch: getBlockFetch });
}

export function getGetBlockAnthropicClient() {
  const apiKey = getGetBlockApiKey();
  const baseURL = `${getGetBlockBaseUrl()}/anthropic-messages/v1`;
  console.log('[getblock] Creating Anthropic messages client', { baseURL, hasApiKey: true });
  return createAnthropic({ apiKey, baseURL, fetch: getBlockFetch });
}

function normalizeSupportedApis(value: unknown): GetBlockApiFormat[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is GetBlockApiFormat => (
    item === 'openai-chat-completions'
    || item === 'openai-responses'
    || item === 'anthropic-messages'
  ));
}

function normalizeCatalogModels(payload: any): GetBlockModel[] {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const models: GetBlockModel[] = [];

  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : '';
    if (!id) continue;
    const supportedApis = normalizeSupportedApis(row?.supported_apis);
    const maxCompletionTokens = readMaxCompletionTokens(row);
    models.push({
      id,
      name: typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : id,
      supportedApis: supportedApis.length > 0 ? supportedApis : ['openai-chat-completions'],
      maxCompletionTokens,
    });
    console.log('[getblock] Catalog model limit', { id, maxCompletionTokens });
  }

  models.sort((a, b) => a.name.localeCompare(b.name));
  console.log('[getblock] Normalized catalog models:', models.length);
  return models;
}

export async function listGetBlockModels(forceRefresh = false): Promise<GetBlockModel[]> {
  if (!forceRefresh && catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    console.log('[getblock] Returning cached catalog', {
      count: catalogCache.models.length,
      ageMs: Date.now() - catalogCache.fetchedAt,
    });
    return catalogCache.models;
  }

  const apiKey = getGetBlockApiKey();
  const url = `${getGetBlockBaseUrl()}/v1/models`;
  console.log('[getblock] Fetching live model catalog:', url);

  // ─── Ariadne's Thread [AT-0016] ─────────────────────
  // What: Retry the GetBlock model catalog when the TCP connect times out
  // Why:  A single 10s connect timeout left the UI with an empty model id
  // Date: 2026-09-30
  // Related: [AT-0015] lib/ai/getblock.ts:getGetBlockMaxCompletionTokens, app/generation/page.tsx:loadGetBlockModels
  // ─────────────────────────────────────────────────────
  let response: Response | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log('[getblock] Catalog attempt', attempt);
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
      });
      break;
    } catch (error) {
      lastError = error;
      console.error('[getblock] Catalog attempt failed', { attempt, error });
      if (attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  if (!response) {
    console.error('[getblock] Catalog request produced no response', lastError);
    throw lastError instanceof Error ? lastError : new Error('GetBlock catalog request failed');
  }

  const bodyText = await response.text();
  if (!response.ok) {
    console.error('[getblock] Catalog request failed', {
      status: response.status,
      body: bodyText.slice(0, 500),
    });
    throw new Error(`GetBlock catalog failed with ${response.status}`);
  }

  let payload: any = {};
  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    console.error('[getblock] Catalog JSON parse failed:', error);
    throw new Error('GetBlock catalog returned invalid JSON');
  }

  const models = normalizeCatalogModels(payload);
  catalogCache = { fetchedAt: Date.now(), models };
  console.log('[getblock] Catalog ready', {
    count: models.length,
    ids: models.map((model) => model.id),
  });
  return models;
}

export function pickGetBlockApi(model: GetBlockModel | undefined, modelId: string): GetBlockApiFormat {
  if (model?.supportedApis.includes('openai-chat-completions')) return 'openai-chat-completions';
  if (model?.supportedApis.includes('anthropic-messages')) return 'anthropic-messages';
  if (model?.supportedApis.includes('openai-responses')) return 'openai-responses';
  if (modelId.startsWith('anthropic/')) return 'anthropic-messages';
  console.log('[getblock] Falling back to OpenAI chat completions for', modelId);
  return 'openai-chat-completions';
}

export async function getGetBlockLanguageModel(modelId: string) {
  console.log('[getblock] Resolving language model:', modelId);
  if (!modelId) {
    throw new Error('GetBlock model id is required');
  }

  let catalogModel: GetBlockModel | undefined;
  try {
    const models = await listGetBlockModels();
    catalogModel = models.find((item) => item.id === modelId);
    if (!catalogModel) {
      console.warn('[getblock] Model is not in the live catalog, routing by id prefix:', modelId);
    }
  } catch (error) {
    console.error('[getblock] Catalog lookup failed, routing by id prefix:', error);
  }

  const api = pickGetBlockApi(catalogModel, modelId);
  console.log('[getblock] Selected API format:', { modelId, api, catalogName: catalogModel?.name });

  if (api === 'anthropic-messages') {
    return getGetBlockAnthropicClient()(modelId);
  }

  if (api === 'openai-responses') {
    return getGetBlockResponsesClient().responses(modelId);
  }

  return getGetBlockChatClient().chat(modelId);
}

export async function getGetBlockMaxCompletionTokens(modelId: string): Promise<number | null> {
  if (!modelId) {
    console.error('[getblock] Cannot resolve max completion tokens without a model id');
    return null;
  }
  try {
    const models = await listGetBlockModels();
    const model = models.find((item) => item.id === modelId);
    const maxCompletionTokens = model?.maxCompletionTokens ?? null;
    console.log('[getblock] Max completion tokens for model', { modelId, maxCompletionTokens });
    return maxCompletionTokens;
  } catch (error) {
    console.error('[getblock] Failed to resolve max completion tokens', { modelId, error });
    return null;
  }
}

const GETBLOCK_DEFAULT_MODEL_ID = 'openai/gpt-5.6-sol';

// ─── Ariadne's Thread [AT-0017] ─────────────────────
// What: Select GPT-5.6-Sol as the default GetBlock model
// Why:  The builder should open on openai/gpt-5.6-sol instead of the first Gemini match
// Date: 2026-09-30
// Related: [AT-0016] app/api/models/route.ts:GET, app/generation/page.tsx:loadGetBlockModels
// ─────────────────────────────────────────────────────
export function getGetBlockDefaultModel(models: GetBlockModel[]): string {
  const chatModels = models.filter((model) => model.supportedApis.includes('openai-chat-completions'));
  const pool = chatModels.length > 0 ? chatModels : models;
  const preferred = pool.find((model) => model.id === GETBLOCK_DEFAULT_MODEL_ID);
  if (!preferred) {
    console.error('[getblock] Default model is missing from the live catalog', GETBLOCK_DEFAULT_MODEL_ID);
  }
  const defaultModel = preferred?.id || pool[0]?.id || '';
  console.log('[getblock] Default model:', defaultModel);
  return defaultModel;
}
