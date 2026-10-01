import { CodeSandbox, describeError, sandboxErrorResponse } from "./code-sandbox";

const SANDBOX_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface SandboxWorkerEnv {
  CODE_SANDBOX: DurableObjectNamespace<CodeSandbox>;
  CLOUDFLARE_SANDBOX_SECRET?: string;
}

// ─── Ariadne's Thread [AT-0011] ─────────────────────
// What: Shared HTTP routes for CodeSandbox control and Vite preview
// Why:  Production Worker and local wrangler.dev share one protocol
// Date: 2026-09-30
// Related: [AT-0008] cloudflare/code-sandbox.ts, [AT-0003] cloudflare/worker.ts
// ─────────────────────────────────────────────────────
export async function routeSandboxRequest(
  request: Request,
  workerEnv: SandboxWorkerEnv,
): Promise<Response | null> {
  const url = new URL(request.url);

  const preview = /^\/previews\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\/.*)?$/.exec(url.pathname);
  if (preview) {
    const sandboxName = preview[1];
    console.log("[code-market-builder] Preview route", sandboxName, preview[2]);
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response("Not found", { status: 404 });
    }
    const sandbox = workerEnv.CODE_SANDBOX.getByName(sandboxName);
    return forwardPreview(sandbox, request, preview[2]);
  }

  const sandboxMatch = /^\/sandboxes\/([^/]+)(?:\/(exec|file|files|preview|status))?$/.exec(url.pathname);
  if (!sandboxMatch) {
    return null;
  }

  const sandboxName = sandboxMatch[1];
  const resource = sandboxMatch[2];
  console.log("[code-market-builder] Sandbox control", request.method, sandboxName, resource ?? "root");
  if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
    return new Response(
      "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start and end with a letter or digit",
      { status: 400 },
    );
  }
  if (!authorizeSandbox(request, workerEnv)) {
    console.warn("[code-market-builder] Rejected sandbox control request without a valid secret");
    return new Response("Unauthorized", { status: 401 });
  }
  const sandbox = workerEnv.CODE_SANDBOX.getByName(sandboxName);
  try {
    return await handleSandboxControl(sandbox, request, sandboxName, resource, url);
  } catch (cause) {
    console.error("[code-market-builder] Sandbox control failed", {
      sandboxName,
      resource,
      error: describeError(cause),
    });
    return sandboxErrorResponse(cause);
  }
}

function authorizeSandbox(request: Request, workerEnv: SandboxWorkerEnv): boolean {
  const expected = workerEnv.CLOUDFLARE_SANDBOX_SECRET;
  if (!expected) {
    console.error("[code-market-builder] CLOUDFLARE_SANDBOX_SECRET is not set");
    return false;
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return token === expected;
}

function forwardPreview(
  sandbox: DurableObjectStub<CodeSandbox>,
  request: Request,
  path: string | undefined,
): Promise<Response> | Response {
  const url = new URL(request.url);
  if (!path) {
    url.pathname += "/";
    console.log("[code-market-builder] Redirecting preview to trailing slash", url.pathname);
    return Response.redirect(url.toString(), 308);
  }
  const target = new URL(request.url);
  target.protocol = "http:";
  target.host = "container";
  console.log("[code-market-builder] Forwarding preview path", target.pathname);
  return sandbox.fetch(new Request(target, request));
}

async function handleSandboxControl(
  sandbox: DurableObjectStub<CodeSandbox>,
  request: Request,
  sandboxName: string,
  resource: string | undefined,
  url: URL,
): Promise<Response> {
  const origin = url.origin;

  if (resource === undefined && request.method === "POST") {
    await sandbox.startSession(sandboxName);
    const previewUrl = `${origin}/previews/${sandboxName}/`;
    console.log("[code-market-builder] Sandbox session started", sandboxName, previewUrl);
    return Response.json({ sandboxId: sandboxName, url: previewUrl, provider: "cloudflare" });
  }

  if (resource === undefined && request.method === "DELETE") {
    await sandbox.destroy();
    console.log("[code-market-builder] Sandbox destroyed", sandboxName);
    return new Response(null, { status: 204 });
  }

  if (resource === "exec" && request.method === "POST") {
    const body = (await request.json()) as { command?: string; argv?: string[]; cwd?: string };
    const argv = body.argv?.length ? body.argv : ["sh", "-c", body.command ?? ""];
    if (!argv[0] || (argv.length === 3 && argv[0] === "sh" && argv[1] === "-c" && !argv[2])) {
      return new Response("command or argv is required", { status: 400 });
    }
    const result = await sandbox.exec(argv, body.cwd);
    return Response.json({
      ...result,
      success: result.exitCode === 0,
    });
  }

  if (resource === "file" && request.method === "PUT") {
    const body = (await request.json()) as { path?: string; content?: string };
    if (!body.path || typeof body.content !== "string") {
      return new Response("path and content are required", { status: 400 });
    }
    await sandbox.writeFile(body.path, body.content);
    return new Response(null, { status: 204 });
  }

  if (resource === "file" && request.method === "POST") {
    const body = (await request.json()) as { path?: string };
    if (!body.path) {
      return new Response("path is required", { status: 400 });
    }
    const content = await sandbox.readFile(body.path);
    return Response.json({ content });
  }

  if (resource === "files" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { directory?: string };
    const files = await sandbox.listFiles(body.directory);
    return Response.json({ files });
  }

  // ─── Ariadne's Thread [AT-0033] ─────────────────────
  // What: Expose a non-creating sandbox health check to provider reconnects
  // Why:  Possessing a sandbox id is not evidence that its container or Vite process survived
  // Date: 2026-09-30
  // Related: [AT-0032] cloudflare/code-sandbox.ts:inspectSession, [AT-0009] backend→lib/sandbox/providers/cloudflare-provider.ts:reconnect
  // ─────────────────────────────────────────────────────
  if (resource === "status" && request.method === "GET") {
    return Response.json(await sandbox.inspectSession(sandboxName));
  }

  if (resource === "preview" && request.method === "POST") {
    const previewUrl = `${origin}/previews/${sandboxName}/`;
    const result = await sandbox.startPreview(sandboxName, previewUrl);
    console.log("[code-market-builder] Preview start result", sandboxName, result.status);
    return Response.json(result, { status: result.status === "ready" ? 200 : 502 });
  }

  return new Response("Method not allowed", { status: 405 });
}
