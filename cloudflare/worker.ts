import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { CodeSandbox } from "./code-sandbox";
import { routeSandboxRequest } from "./sandbox-http";
import { LaunchRun } from "./launch-run";
import { routeLaunchRequest } from "./launch-http";
import { BuilderPromptStore } from "./builder-prompt-store";

export { CodeSandbox, LaunchRun, BuilderPromptStore };

// ─── Ariadne's Thread [AT-0003] ─────────────────────
// What: Route builder UI to one container and sandboxes to per-session DOs
// Why:  Next.js keeps chat state in memory; each generated app needs its own Linux VM
// Date: 2026-09-30
// Related: [AT-0001] next.config.ts, [AT-0002] Dockerfile, [AT-0011] cloudflare/sandbox-http.ts
// ─────────────────────────────────────────────────────
export class CodeMarketContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "30m";
  // ─── Ariadne's Thread [AT-0039] ─────────────────────
  // What: Pass generation and scraping credentials into the builder container
  // Why:  LaunchRun invokes Next.js internally, so the container must receive the same provider environment as the Worker
  // Date: 2026-09-30
  // Related: [AT-0038] cloudflare/launch-run.ts:generateArtifact, [AT-0036] backend→lib/ai/launch-generation-service.ts:generateLaunchArtifactText
  // ─────────────────────────────────────────────────────
  envVars = {
    SANDBOX_PROVIDER: "cloudflare",
    CLOUDFLARE_SANDBOX_URL: env.CLOUDFLARE_SANDBOX_PUBLIC_URL ?? "",
    CLOUDFLARE_SANDBOX_SECRET: env.CLOUDFLARE_SANDBOX_SECRET ?? "",
    GETBLOCK_API_KEY: env.GETBLOCK_API_KEY ?? "",
    GETBLOCK_INFERENCE_BASE_URL: env.GETBLOCK_INFERENCE_BASE_URL ?? "https://inference.eu-central-1.getblock.io",
    FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY ?? "",
    MORPH_API_KEY: env.MORPH_API_KEY ?? "",
    NEXT_PUBLIC_APP_URL: env.CLOUDFLARE_SANDBOX_PUBLIC_URL ?? "",
    LAUNCH_ORCHESTRATOR_V2_ENABLED: env.LAUNCH_ORCHESTRATOR_V2_ENABLED ?? "false",
    BUILDER_INTERNAL_SECRET: env.BUILDER_INTERNAL_SECRET ?? "",
  };
}

interface Env {
  CODE_MARKET: DurableObjectNamespace;
  CODE_SANDBOX: DurableObjectNamespace<CodeSandbox>;
  LAUNCH_RUN: DurableObjectNamespace<LaunchRun>;
  BUILDER_PROMPTS: DurableObjectNamespace<BuilderPromptStore>;
  CLOUDFLARE_SANDBOX_SECRET?: string;
  BUILDER_INTERNAL_SECRET?: string;
  CLOUDFLARE_SANDBOX_PUBLIC_URL?: string;
  GETBLOCK_API_KEY?: string;
  GETBLOCK_INFERENCE_BASE_URL?: string;
  FIRECRAWL_API_KEY?: string;
  MORPH_API_KEY?: string;
  LAUNCH_ORCHESTRATOR_V2_ENABLED?: string;
}

export default {
  async fetch(request: Request, workerEnv: Env): Promise<Response> {
    const url = new URL(request.url);
    console.log("[code-market-builder] Incoming", request.method, url.pathname);

    // ─── Ariadne's Thread [AT-0027] ─────────────────────
    // What: Route durable launch control and stable previews before raw sandbox traffic
    // Why:  Every generated revision needs one persistent coordinator and an invariant public URL
    // Date: 2026-09-30
    // Related: [AT-0026] infra→cloudflare/launch-http.ts:routeLaunchRequest, [AT-0011] infra→cloudflare/sandbox-http.ts:routeSandboxRequest
    // ─────────────────────────────────────────────────────
    const launchResponse = await routeLaunchRequest(request, workerEnv);
    if (launchResponse) {
      return launchResponse;
    }

    const sandboxResponse = await routeSandboxRequest(request, workerEnv);
    if (sandboxResponse) {
      return sandboxResponse;
    }

    console.log("[code-market-builder] Forwarding request to builder container:", request.method, url.pathname);
    return workerEnv.CODE_MARKET.getByName("code-market").fetch(request);
  },
} satisfies ExportedHandler<Env>;
