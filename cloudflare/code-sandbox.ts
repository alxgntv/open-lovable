import { Files, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

// ─── Ariadne's Thread [AT-0008] ─────────────────────
// What: One Durable Object + Container per customer Vite session
// Why:  Cloudflare Sandboxes 1.0 own the Linux VM from the DO, not from Next.js
// Date: 2026-09-30
// Related: [AT-0007] cloudflare/sandbox.Dockerfile, [AT-0003] cloudflare/worker.ts, [AT-0009] lib/sandbox/providers/cloudflare-provider.ts
// ─────────────────────────────────────────────────────

const APP_DIRECTORY = "/workspace/app";
const DEV_SERVER_LOG_PATH = "/tmp/dev-server.log";
const DEV_SERVER_PORT = 5173;
const DEV_SERVER_START_TIMEOUT_MS = 60_000;
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1_000;
const NOT_LISTENING_PREFIXES = [
  "The container is not listening in the TCP address ",
  "Container is not listening to port ",
];

export type PreviewResult =
  | { status: "ready"; url: string }
  | { status: "exited"; exitCode: number; log: string }
  | { status: "timed-out"; log: string };

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CodeSandbox extends DurableObject {
  readonly #container: Container;
  readonly #files: Files;
  #starting: Promise<PreviewResult> | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#files = new Files(this.#container);
    if (this.#container.running) {
      console.log("[CodeSandbox] Durable Object woke with a running container, resetting inactivity timeout");
      void ctx.blockConcurrencyWhile(() => this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  async startSession(sandboxName: string): Promise<void> {
    console.log("[CodeSandbox] startSession", sandboxName);
    await this.#ensureExecution(sandboxName);
  }

  // ─── Ariadne's Thread [AT-0032] ─────────────────────
  // What: Report actual container and Vite readiness without implicitly creating a session
  // Why:  Reconnect logic must distinguish a persisted identifier from a live runnable candidate
  // Date: 2026-09-30
  // Related: [AT-0031] infra→cloudflare/candidate-runtime.ts:buildCandidateRuntime, [AT-0009] backend→lib/sandbox/providers/cloudflare-provider.ts:reconnect
  // ─────────────────────────────────────────────────────
  async inspectSession(sandboxName: string): Promise<{
    containerRunning: boolean;
    previewReady: boolean;
    log: string;
  }> {
    if (!this.#container.running) {
      console.log("[CodeSandbox] inspectSession found a stopped container", sandboxName);
      return { containerRunning: false, previewReady: false, log: "" };
    }
    const previewReady = await this.#devServerAnswers(sandboxName);
    const log = previewReady ? "" : await this.#devServerLog();
    console.log("[CodeSandbox] inspectSession", {
      sandboxName,
      containerRunning: true,
      previewReady,
      logBytes: log.length,
    });
    return { containerRunning: true, previewReady, log };
  }

  async exec(argv: string[], cwd = APP_DIRECTORY): Promise<SandboxExecResult> {
    console.log("[CodeSandbox] exec", { argv, cwd });
    const container = await this.#ensureExecution();
    const process = await container.exec(argv, { cwd });
    const output = await process.output();
    const decoder = new TextDecoder();
    const result = {
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      exitCode: output.exitCode,
    };
    console.log("[CodeSandbox] exec finished", {
      argv,
      exitCode: result.exitCode,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
    });
    return result;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = resolveWorkspacePath(path);
    console.log("[CodeSandbox] writeFile", fullPath, "bytes=", content.length);
    await this.#ensureExecution();
    const parent = fullPath.slice(0, fullPath.lastIndexOf("/"));
    if (parent) {
      await this.#files.mkdir(parent, { recursive: true });
    }
    await this.#files.writeFile(fullPath, content);
    console.log("[CodeSandbox] writeFile done", fullPath);
  }

  async readFile(path: string): Promise<string> {
    const fullPath = resolveWorkspacePath(path);
    console.log("[CodeSandbox] readFile", fullPath);
    await this.#ensureExecution();
    const response = await this.#files.readFile(fullPath);
    const text = await response.text();
    console.log("[CodeSandbox] readFile done", fullPath, "bytes=", text.length);
    return text;
  }

  async listFiles(directory = APP_DIRECTORY): Promise<string[]> {
    const fullDirectory = resolveWorkspacePath(directory);
    console.log("[CodeSandbox] listFiles", fullDirectory);
    const result = await this.exec([
      "find",
      fullDirectory,
      "-type",
      "f",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/.next/*",
      "-not",
      "-path",
      "*/dist/*",
      "-not",
      "-path",
      "*/build/*",
    ]);
    if (result.exitCode !== 0) {
      console.error("[CodeSandbox] listFiles find failed", result.stderr);
      return [];
    }
    const files = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((absolute) =>
        absolute.startsWith(`${fullDirectory}/`) ? absolute.slice(fullDirectory.length + 1) : absolute,
      );
    console.log("[CodeSandbox] listFiles count", files.length);
    return files;
  }

  async startPreview(sandboxName: string, previewUrl: string): Promise<PreviewResult> {
    console.log("[CodeSandbox] startPreview", sandboxName, previewUrl);
    if (this.#starting !== undefined) {
      console.log("[CodeSandbox] startPreview already in flight");
      return this.#starting;
    }
    const starting = this.#startPreview(sandboxName, previewUrl).finally(() => {
      if (this.#starting === starting) this.#starting = undefined;
    });
    this.#starting = starting;
    return starting;
  }

  async destroy(): Promise<void> {
    console.log("[CodeSandbox] destroy");
    this.#starting = undefined;
    if (this.#container.running) {
      await this.#container.destroy();
      console.log("[CodeSandbox] container destroyed");
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    url.protocol = "http:";
    console.log("[CodeSandbox] preview fetch", request.method, url.pathname);
    try {
      return await this.#container.getTcpPort(DEV_SERVER_PORT).fetch(new Request(url, request));
    } catch (cause) {
      if (!isNotListening(cause)) {
        console.error("[CodeSandbox] preview forward failed", describeError(cause));
      } else {
        console.warn("[CodeSandbox] preview port is not listening yet", url.pathname);
      }
      return new Response("Preview is not running", { status: 503 });
    }
  }

  async #ensureExecution(sandboxName?: string): Promise<Container> {
    if (this.#container.running) {
      return this.#container;
    }
    console.log("[CodeSandbox] starting workspace container", {
      sandboxName,
      instance: "standard-1",
      enableInternet: true,
    });
    this.#container.start({
      image: this.#container.images.workspace,
      instance: "standard-1",
      enableInternet: true,
      ...(sandboxName ? { labels: { sandbox: sandboxName } } : {}),
    });
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    console.log("[CodeSandbox] container started, inactivity timeout ms=", INACTIVITY_TIMEOUT_MS);
    return this.#container;
  }

  async #startPreview(sandboxName: string, previewUrl: string): Promise<PreviewResult> {
    await this.#ensureExecution(sandboxName);
    const ready: PreviewResult = { status: "ready", url: previewUrl };
    if (await this.#devServerAnswers(sandboxName)) {
      console.log("[CodeSandbox] Vite already answering", previewUrl);
      return ready;
    }

    await this.#fixDoubledPreviewScript(sandboxName);
    console.log("[CodeSandbox] launching Vite in the background");
    const server = await this.#container.exec(
      [
        "/bin/sh",
        "-c",
        `exec ./node_modules/.bin/vite --host 0.0.0.0 --port ${DEV_SERVER_PORT} --strictPort >${DEV_SERVER_LOG_PATH} 2>&1`,
      ],
      {
        cwd: APP_DIRECTORY,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const exited = new AbortController();
    let exitCode: number | undefined;
    server.exitCode.then(
      (code) => {
        exitCode = code;
        console.error("[CodeSandbox] Vite process exited", code);
        exited.abort();
      },
      (cause: unknown) => {
        console.error("[CodeSandbox] Vite process failed", describeError(cause));
        exited.abort(cause);
      },
    );
    const signal = AbortSignal.any([exited.signal, AbortSignal.timeout(DEV_SERVER_START_TIMEOUT_MS)]);

    while (!signal.aborted) {
      try {
        if (await this.#devServerAnswers(sandboxName, signal)) {
          console.log("[CodeSandbox] Vite is ready", previewUrl);
          return ready;
        }
        await scheduler.wait(100, { signal });
      } catch (cause) {
        if (!signal.aborted) throw cause;
      }
    }
    if (exitCode !== undefined) {
      const log = await this.#devServerLog();
      console.error("[CodeSandbox] Vite exited before listen", { exitCode, log });
      return { status: "exited", exitCode, log };
    }
    if (exited.signal.aborted) throw exited.signal.reason;
    server.kill();
    const log = await this.#devServerLog();
    console.error("[CodeSandbox] Vite start timed out", log);
    return { status: "timed-out", log };
  }

  async #devServerAnswers(sandboxName: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.#container
        .getTcpPort(DEV_SERVER_PORT)
        .fetch(`http://localhost/previews/${sandboxName}/`, { signal });
      await response.body?.cancel();
      return true;
    } catch (cause) {
      if (isNotListening(cause)) return false;
      throw cause;
    }
  }

  async #fixDoubledPreviewScript(sandboxName: string): Promise<void> {
    const doubledScript = `/previews/${sandboxName}/src/main.jsx`;
    try {
      const html = await (await this.#files.readFile(`${APP_DIRECTORY}/index.html`)).text();
      if (!html.includes(doubledScript)) {
        return;
      }
      console.log("[CodeSandbox] Rewriting doubled Vite script path", doubledScript);
      await this.#files.writeFile(`${APP_DIRECTORY}/index.html`, html.replaceAll(doubledScript, "/src/main.jsx"));
    } catch (cause) {
      console.error("[CodeSandbox] Could not rewrite index.html script path", describeError(cause));
    }
  }

  async #devServerLog(): Promise<string> {
    try {
      return (await this.#files.readFile(DEV_SERVER_LOG_PATH)).text();
    } catch (cause) {
      console.error("[CodeSandbox] could not read Vite log", describeError(cause));
      return "";
    }
  }
}

export function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}

export function sandboxErrorResponse(cause: unknown): Response {
  console.error("[CodeSandbox] request failed", describeError(cause));
  if (SandboxFileError.is(cause)) {
    if (cause.code === "ENOENT") return new Response("No such file or directory", { status: 404 });
    if (cause.code === "EACCES" || cause.code === "EPERM") {
      return new Response("Permission denied", { status: 403 });
    }
    return new Response(`Workspace file operation failed: ${cause.code}`, { status: 500 });
  }
  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox file protocol failed", { status: 500 });
  }
  return new Response(cause instanceof Error ? cause.message : "Sandbox request failed", { status: 500 });
}

function isNotListening(cause: unknown): boolean {
  return cause instanceof Error && NOT_LISTENING_PREFIXES.some((prefix) => cause.message.startsWith(prefix));
}

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (container === undefined) {
    throw new Error("Container attachment is unavailable");
  }
  return container;
}

function resolveWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.includes("\0") || trimmed.split("/").includes("..")) {
    throw new Error(`Invalid sandbox path: ${path}`);
  }
  if (trimmed.startsWith("/")) {
    if (trimmed !== "/workspace" && !trimmed.startsWith("/workspace/")) {
      throw new Error(`Sandbox path must stay under /workspace: ${path}`);
    }
    return trimmed;
  }
  return `${APP_DIRECTORY}/${trimmed}`;
}
