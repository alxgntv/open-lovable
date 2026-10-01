import { CodeSandbox } from "./code-sandbox";
import { routeSandboxRequest } from "./sandbox-http";
import { LaunchRun } from "./launch-run";
import { routeLaunchRequest } from "./launch-http";
import { BuilderPromptStore } from "./builder-prompt-store";

export { CodeSandbox, LaunchRun, BuilderPromptStore };

// ─── Ariadne's Thread [AT-0012] ─────────────────────
// What: Local Worker entry that only hosts CodeSandbox
// Why:  wrangler.dev must not build the production Next.js container image
// Date: 2026-09-30
// Related: [AT-0011] cloudflare/sandbox-http.ts, wrangler.local.jsonc
// ─────────────────────────────────────────────────────

interface Env {
  CODE_SANDBOX: DurableObjectNamespace<CodeSandbox>;
  LAUNCH_RUN: DurableObjectNamespace<LaunchRun>;
  BUILDER_PROMPTS: DurableObjectNamespace<BuilderPromptStore>;
  CLOUDFLARE_SANDBOX_SECRET?: string;
  BUILDER_INTERNAL_SECRET?: string;
  LAUNCH_BUILDER_ORIGIN?: string;
}

export default {
  async fetch(request: Request, workerEnv: Env): Promise<Response> {
    const url = new URL(request.url);
    console.log("[code-market-builder-local] Incoming", request.method, url.pathname);
    // ─── Ariadne's Thread [AT-0029] ─────────────────────
    // What: Expose the same launch-run protocol from the local sandbox Worker
    // Why:  Local fault tests must exercise durable baseline and event behavior before production deployment
    // Date: 2026-09-30
    // Related: [AT-0026] infra→cloudflare/launch-http.ts:routeLaunchRequest, [AT-0012] cloudflare/worker-local.ts:fetch
    // ─────────────────────────────────────────────────────
    const launchResponse = await routeLaunchRequest(request, workerEnv);
    if (launchResponse) {
      return launchResponse;
    }
    const sandboxResponse = await routeSandboxRequest(request, workerEnv);
    if (sandboxResponse) {
      return sandboxResponse;
    }
    return new Response("Local Worker only handles launch, sandbox, and preview routes", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
