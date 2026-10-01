import { streamText } from 'ai';
import {
  getGetBlockDefaultModel,
  getGetBlockLanguageModel,
  getGetBlockMaxCompletionTokens,
  listGetBlockModels,
} from './getblock';
import type { LaunchFidelity } from '@/lib/launch/types';

export interface LaunchGenerationInput {
  prompt: string;
  model?: string;
  sourceContext?: string;
  diagnostics?: string;
  currentArtifact?: string;
  fidelity: LaunchFidelity;
}

export interface LaunchGenerationResult {
  generatedCode: string;
  model: string;
  packagesToInstall: string[];
  explanation: string;
}

export type LaunchGenerationEvent =
  | { type: 'status'; message: string }
  | { type: 'stream'; text: string; raw: true };

function packageNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/<package>([^<]+)<\/package>/gi)) {
    const name = match[1].trim();
    if (name) names.add(name);
  }
  for (const match of text.matchAll(/<packages>([^<]+)<\/packages>/gi)) {
    for (const name of match[1].split(/[\s,]+/)) {
      if (name.trim()) names.add(name.trim());
    }
  }
  return [...names];
}

function fidelityInstructions(fidelity: LaunchFidelity): string {
  if (fidelity === 'dependency-free') {
    return 'Use only React, ReactDOM, browser APIs, and CSS. Do not request any additional npm package.';
  }
  if (fidelity === 'mocked') {
    return 'Replace every external API, credential, database, payment, authentication, and remote service with deterministic local mock data and interactions.';
  }
  if (fidelity === 'baseline') {
    return 'Build a minimal self-contained interactive MVP with no remote dependencies.';
  }
  return 'Implement the requested product faithfully, but keep all unavailable external integrations behind working local fallbacks.';
}

// ─── Ariadne's Thread [AT-0062] ─────────────────────
// What: Constrain durable generation to one compact app file and lower OpenAI reasoning latency
// Why:  GPT-5.6-Sol streamed valid code but exceeded the launch deadline before closing a multi-file artifact
// Date: 2026-09-30
// Related: [AT-0036] lib/ai/launch-generation-service.ts:generateLaunchArtifactText, [AT-0042] lib/ai/getblock.ts:getBlockFetch, [AT-0038] infra→cloudflare/launch-run.ts:generateArtifact
// ─────────────────────────────────────────────────────
function generationSystemPrompt(fidelity: LaunchFidelity): string {
  return `You generate a complete browser-runnable React 18 + Vite product candidate.

OUTPUT CONTRACT:
- Return exactly one complete <file path="src/App.jsx">...</file> block.
- Keep the entire response focused and under 10000 characters.
- Implement the whole product in that one file; do not import local files or additional npm packages.
- Never use Markdown fences, ellipses, placeholders, TODO comments, or prose outside the tags.
- Do not output package.json, vite.config, Tailwind config, or PostCSS config; the launcher owns runtime configuration.
- Use React hooks, browser APIs, and Tailwind utility classes only.
- UI copy, console messages, and runtime errors must be in English.
- The first render must contain visible, meaningful content and at least one safe local interaction marked with data-smoke-action.
- The data-smoke-action element must be a type="button" button whose click changes visible local UI without navigation, credentials, or a remote request.
- Do not require environment variables for the first render.
- Every image must use the page title for alt and title, and the page description for description.
- Keep the candidate compact enough to complete without truncation.

DEGRADATION CONTRACT:
${fidelityInstructions(fidelity)}

Correctness and immediate renderability are more important than breadth.`;
}

// ─── Ariadne's Thread [AT-0036] ─────────────────────
// What: Generate a complete launch artifact through a reusable GetBlock service
// Why:  Durable orchestration needs generation independent of route-local globals and client SSE lifetime
// Date: 2026-09-30
// Related: [AT-0017] lib/ai/getblock.ts:getGetBlockDefaultModel, [AT-0023] shared→lib/launch/artifact.ts:parseGeneratedArtifact
// ─────────────────────────────────────────────────────
export async function generateLaunchArtifactText(
  input: LaunchGenerationInput,
  onEvent: (event: LaunchGenerationEvent) => Promise<void> | void = () => undefined,
): Promise<LaunchGenerationResult> {
  let model = input.model?.trim() ?? '';
  if (!model) {
    const catalog = await listGetBlockModels();
    model = getGetBlockDefaultModel(catalog);
  }

  const context = [
    input.sourceContext ? `SOURCE CONTEXT:\n${input.sourceContext}` : '',
    input.diagnostics ? `FAILURE DIAGNOSTICS TO FIX:\n${input.diagnostics.slice(0, 20_000)}` : '',
    input.currentArtifact ? `CURRENT ARTIFACT:\n${input.currentArtifact.slice(0, 80_000)}` : '',
  ].filter(Boolean).join('\n\n');

  console.log('[launch-generation-service] Starting artifact generation', {
    model,
    fidelity: input.fidelity,
    promptChars: input.prompt.length,
    contextChars: context.length,
    hasDiagnostics: Boolean(input.diagnostics),
    hasCurrentArtifact: Boolean(input.currentArtifact),
  });
  await onEvent({ type: 'status', message: 'Generating a complete candidate artifact...' });

  const maxOutputTokens = await getGetBlockMaxCompletionTokens(model);
  const openAiReasoningEffort = model.startsWith('openai/') ? 'low' : undefined;
  console.log('[launch-generation-service] Inference request configured', {
    model,
    maxOutputTokens,
    openAiReasoningEffort: openAiReasoningEffort ?? null,
    outputContract: 'single-file-compact',
  });
  const generationStartedAt = Date.now();
  const result = await streamText({
    model: await getGetBlockLanguageModel(model),
    system: generationSystemPrompt(input.fidelity),
    prompt: `${input.prompt}\n\n${context}`.trim(),
    maxOutputTokens: maxOutputTokens ?? undefined,
    ...(openAiReasoningEffort
      ? {
          experimental_providerMetadata: {
            openai: { reasoningEffort: openAiReasoningEffort },
          },
        }
      : {}),
  });

  let generatedCode = '';
  let nextProgressLogChars = 1_000;
  for await (const chunk of result.textStream) {
    generatedCode += chunk;
    await onEvent({ type: 'stream', text: chunk, raw: true });
    if (generatedCode.length >= nextProgressLogChars) {
      console.log('[launch-generation-service] Artifact stream progress', {
        model,
        fidelity: input.fidelity,
        generatedChars: generatedCode.length,
        elapsedMs: Date.now() - generationStartedAt,
      });
      while (nextProgressLogChars <= generatedCode.length) {
        nextProgressLogChars += 1_000;
      }
    }
  }
  if (!generatedCode.trim()) {
    throw new Error('Invalid artifact: model generated no files');
  }

  const packagesToInstall = packageNames(generatedCode);
  console.log('[launch-generation-service] Artifact generation completed', {
    model,
    fidelity: input.fidelity,
    generatedChars: generatedCode.length,
    packages: packagesToInstall,
    durationMs: Date.now() - generationStartedAt,
  });
  return {
    generatedCode,
    model,
    packagesToInstall,
    explanation: `Generated a ${input.fidelity} candidate for durable validation.`,
  };
}

export function createLaunchGenerationStream(input: LaunchGenerationInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        const result = await generateLaunchArtifactText(input, async (event) => send(event));
        send({ type: 'complete', ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[launch-generation-service] Artifact generation failed', {
          message,
          stack: error instanceof Error ? error.stack : undefined,
        });
        send({ type: 'error', error: message });
      } finally {
        controller.close();
      }
    },
  });
}
