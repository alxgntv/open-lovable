import { getGetBlockLanguageModel } from '@/lib/ai/getblock';

// ─── Ariadne's Thread [AT-0006] ─────────────────────
// What: Route every generation model through GetBlock Inference
// Why:  Direct OpenAI/Anthropic/Groq/Gemini connectors are replaced by the GetBlock gateway
// Date: 2026-09-30
// Related: [AT-0006] app/api/generate-ai-code-stream/route.ts, lib/ai/getblock.ts
// ─────────────────────────────────────────────────────

export async function getProviderForModel(modelId: string) {
  console.log('[provider-manager] Resolving GetBlock model:', modelId);
  const client = await getGetBlockLanguageModel(modelId);
  return { client, actualModel: modelId };
}

export default getProviderForModel;
