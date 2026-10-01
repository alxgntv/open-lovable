import { customAlphabet } from 'nanoid';
import { SandboxProvider, SandboxInfo, CommandResult } from '../types';
import { appConfig } from '@/config/app.config';

const sandboxIdAlphabet = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);

// ─── Ariadne's Thread [AT-0009] ─────────────────────
// What: Talk to the Worker CodeSandbox Durable Object over HTTP
// Why:  Next.js cannot call ctx.container; Cloudflare Sandboxes only start inside a Worker
// Date: 2026-09-30
// Related: [AT-0008] cloudflare/code-sandbox.ts, [AT-0010] lib/sandbox/factory.ts
// ─────────────────────────────────────────────────────
export class CloudflareProvider extends SandboxProvider {
  private existingFiles: Set<string> = new Set();
  private sandboxId: string | null = null;

  async reconnect(sandboxId: string): Promise<boolean> {
    try {
      console.log('[CloudflareProvider] Reconnecting to sandbox', sandboxId);
      // ─── Ariadne's Thread [AT-0034] ─────────────────────
      // What: Verify the remote container before accepting a Cloudflare sandbox reconnect
      // Why:  The old implementation treated every syntactically valid id as a healthy live sandbox
      // Date: 2026-09-30
      // Related: [AT-0033] infra→cloudflare/sandbox-http.ts:status, [AT-0010] lib/sandbox/factory.ts:SandboxFactory
      // ─────────────────────────────────────────────────────
      const health = await this.requestJson<{
        containerRunning: boolean;
        previewReady: boolean;
        log: string;
      }>(sandboxId, '/status', { method: 'GET' });
      if (!health.containerRunning) {
        console.warn('[CloudflareProvider] Sandbox container is not running', {
          sandboxId,
          previewReady: health.previewReady,
          logBytes: health.log?.length ?? 0,
        });
        return false;
      }
      this.sandboxId = sandboxId;
      this.sandbox = { sandboxId };
      const previewUrl = `${this.workerUrl()}/previews/${sandboxId}/`;
      this.sandboxInfo = {
        sandboxId,
        url: previewUrl,
        provider: 'cloudflare',
        createdAt: new Date()
      };
      console.log('[CloudflareProvider] Reconnected sandbox', {
        sandboxId,
        previewUrl,
        previewReady: health.previewReady,
      });
      return true;
    } catch (error) {
      console.error(`[CloudflareProvider] Failed to reconnect to sandbox ${sandboxId}:`, error);
      return false;
    }
  }

  async createSandbox(): Promise<SandboxInfo> {
    try {
      if (this.sandboxId) {
        console.log('[CloudflareProvider] Destroying existing sandbox before create', this.sandboxId);
        try {
          await this.terminate();
        } catch (error) {
          console.error('[CloudflareProvider] Failed to terminate existing sandbox:', error);
        }
      }

      this.existingFiles.clear();
      this.sandboxId = `cm${sandboxIdAlphabet()}`;
      console.log('[CloudflareProvider] Creating Cloudflare sandbox', this.sandboxId);

      const created = await this.requestJson<{ sandboxId: string; url: string }>(
        this.sandboxId,
        '',
        { method: 'POST' }
      );

      this.sandbox = { sandboxId: this.sandboxId };
      this.sandboxInfo = {
        sandboxId: created.sandboxId,
        url: created.url,
        provider: 'cloudflare',
        createdAt: new Date()
      };

      console.log('[CloudflareProvider] Sandbox created', this.sandboxInfo);
      return this.sandboxInfo;
    } catch (error) {
      console.error('[CloudflareProvider] Error creating sandbox:', error);
      throw error;
    }
  }

  async runCommand(command: string): Promise<CommandResult> {
    this.requireSandbox();
    console.log('[CloudflareProvider] runCommand', command);
    const result = await this.requestJson<CommandResult>(this.sandboxId!, '/exec', {
      method: 'POST',
      body: JSON.stringify({ command, cwd: appConfig.cloudflareSandbox.workingDirectory })
    });
    console.log('[CloudflareProvider] runCommand finished', {
      command,
      exitCode: result.exitCode,
      stdoutBytes: result.stdout?.length ?? 0,
      stderrBytes: result.stderr?.length ?? 0
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 1,
      success: result.exitCode === 0
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.requireSandbox();
    const fullPath = path.startsWith('/') ? path : `${appConfig.cloudflareSandbox.workingDirectory}/${path}`;
    console.log('[CloudflareProvider] writeFile', fullPath, 'bytes=', content.length);
    await this.request(this.sandboxId!, '/file', {
      method: 'PUT',
      body: JSON.stringify({ path: fullPath, content })
    });
    this.existingFiles.add(path);
    console.log('[CloudflareProvider] writeFile done', fullPath);
  }

  async readFile(path: string): Promise<string> {
    this.requireSandbox();
    const fullPath = path.startsWith('/') ? path : `${appConfig.cloudflareSandbox.workingDirectory}/${path}`;
    console.log('[CloudflareProvider] readFile', fullPath);
    const result = await this.requestJson<{ content: string }>(this.sandboxId!, '/file', {
      method: 'POST',
      body: JSON.stringify({ path: fullPath })
    });
    console.log('[CloudflareProvider] readFile done', fullPath, 'bytes=', result.content?.length ?? 0);
    return result.content ?? '';
  }

  async listFiles(directory: string = appConfig.cloudflareSandbox.workingDirectory): Promise<string[]> {
    this.requireSandbox();
    console.log('[CloudflareProvider] listFiles', directory);
    const result = await this.requestJson<{ files: string[] }>(this.sandboxId!, '/files', {
      method: 'POST',
      body: JSON.stringify({ directory })
    });
    console.log('[CloudflareProvider] listFiles count', result.files?.length ?? 0);
    return result.files ?? [];
  }

  async installPackages(packages: string[]): Promise<CommandResult> {
    this.requireSandbox();
    const flags = appConfig.packages.useLegacyPeerDeps ? '--legacy-peer-deps' : '';
    const command = ['npm', 'install', flags, ...packages].filter(Boolean).join(' ');
    console.log('[CloudflareProvider] installPackages', packages);
    const result = await this.runCommand(command);
    if (appConfig.packages.autoRestartVite && result.success) {
      console.log('[CloudflareProvider] Restarting Vite after package install');
      await this.restartViteServer();
    }
    return result;
  }

  async setupViteApp(): Promise<void> {
    this.requireSandbox();
    const sandboxId = this.sandboxId!;
    const previewBase = `/previews/${sandboxId}/`;
    console.log('[CloudflareProvider] Setting up Vite React app', { sandboxId, previewBase });

    await this.runCommand(`mkdir -p ${appConfig.cloudflareSandbox.workingDirectory}/src`);

    const packageJson = {
      name: 'sandbox-app',
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'vite --host',
        build: 'vite build',
        preview: 'vite preview'
      },
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0'
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.0.0',
        vite: '^4.3.9',
        tailwindcss: '^3.3.0',
        postcss: '^8.4.31',
        autoprefixer: '^10.4.16'
      }
    };
    await this.writeFile('package.json', JSON.stringify(packageJson, null, 2));

    const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: ${JSON.stringify(previewBase)},
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    hmr: false,
    allowedHosts: true
  }
})`;
    await this.writeFile('vite.config.js', viteConfig);

    const tailwindConfig = `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}`;
    await this.writeFile('tailwind.config.js', tailwindConfig);

    const postcssConfig = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}`;
    await this.writeFile('postcss.config.js', postcssConfig);

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sandbox App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`;
    await this.writeFile('index.html', indexHtml);

    const mainJsx = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`;
    await this.writeFile('src/main.jsx', mainJsx);

    const appJsx = `function App() {
  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <div className="text-center max-w-2xl">
        <p className="text-lg text-gray-400">
          Sandbox Ready<br/>
          Start building your React app with Vite and Tailwind CSS!
        </p>
      </div>
    </div>
  )
}

export default App`;
    await this.writeFile('src/App.jsx', appJsx);

    const indexCss = `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  background-color: rgb(17 24 39);
}`;
    await this.writeFile('src/index.css', indexCss);

    // ─── Ariadne's Thread [AT-0014] ─────────────────────
    // What: Skip npm install when the sandbox image already has Vite
    // Why:  Fresh npm install in the VM exceeded the 180s HTTP timeout
    // Date: 2026-09-30
    // Related: [AT-0007] cloudflare/sandbox.Dockerfile
    // ─────────────────────────────────────────────────────
    const viteCheck = await this.runCommand(
      'if [ -x node_modules/.bin/vite ]; then echo VITE_OK; else echo VITE_MISSING; fi'
    );
    console.log('[CloudflareProvider] Vite binary check', {
      stdout: viteCheck.stdout.trim(),
      exitCode: viteCheck.exitCode,
    });
    if (viteCheck.stdout.includes('VITE_OK')) {
      console.log('[CloudflareProvider] Using preinstalled node_modules from the sandbox image');
    } else {
      console.log('[CloudflareProvider] Installing npm packages');
      const install = await this.runCommand(
        appConfig.packages.useLegacyPeerDeps ? 'npm install --legacy-peer-deps' : 'npm install'
      );
      if (!install.success) {
        console.error('[CloudflareProvider] npm install failed', install.stderr);
        throw new Error(`npm install failed: ${install.stderr || install.stdout || 'unknown error'}`);
      }
      console.log('[CloudflareProvider] npm install succeeded');
    }

    console.log('[CloudflareProvider] Starting Vite preview');
    const preview = await this.requestJson<{ status: string; url?: string; log?: string }>(
      sandboxId,
      '/preview',
      { method: 'POST' }
    );
    if (preview.status !== 'ready' || !preview.url) {
      console.error('[CloudflareProvider] Vite failed to start', preview);
      throw new Error(`Vite failed to start: ${preview.log || preview.status}`);
    }
    if (this.sandboxInfo) {
      this.sandboxInfo.url = preview.url;
    }
    console.log('[CloudflareProvider] Vite ready at', preview.url);

    this.existingFiles.add('src/App.jsx');
    this.existingFiles.add('src/main.jsx');
    this.existingFiles.add('src/index.css');
    this.existingFiles.add('index.html');
    this.existingFiles.add('package.json');
    this.existingFiles.add('vite.config.js');
    this.existingFiles.add('tailwind.config.js');
    this.existingFiles.add('postcss.config.js');
  }

  async recoverDeadVite(): Promise<void> {
    this.requireSandbox();
    console.log('[CloudflareProvider] Recovering a dead Vite process');
    await this.runCommand('pkill -f esbuild || true; pkill -f vite || true');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await this.restartViteServer();
  }

  async restartViteServer(): Promise<void> {
    this.requireSandbox();
    console.log('[CloudflareProvider] Ensuring Vite is running');
    await this.fixDoubledPreviewScript();
    const preview = await this.requestJson<{ status: string; url?: string; log?: string }>(
      this.sandboxId!,
      '/preview',
      { method: 'POST' }
    );
    if (preview.status !== 'ready') {
      console.error('[CloudflareProvider] Vite restart failed', preview);
      throw new Error(`Vite restart failed: ${preview.log || preview.status}`);
    }
    console.log('[CloudflareProvider] Vite restarted', preview.url);
  }

  private async fixDoubledPreviewScript(): Promise<void> {
    const previewBase = `/previews/${this.sandboxId}/`;
    const doubledScript = `${previewBase}src/main.jsx`;
    try {
      const html = await this.readFile('index.html');
      if (!html.includes(doubledScript)) {
        return;
      }
      const fixed = html.replaceAll(doubledScript, '/src/main.jsx');
      console.log('[CloudflareProvider] Rewriting doubled Vite script path in index.html');
      await this.writeFile('index.html', fixed);
    } catch (error) {
      console.error('[CloudflareProvider] Could not rewrite index.html script path:', error);
    }
  }

  getSandboxUrl(): string | null {
    return this.sandboxInfo?.url || null;
  }

  getSandboxInfo(): SandboxInfo | null {
    return this.sandboxInfo;
  }

  async terminate(): Promise<void> {
    if (!this.sandboxId) {
      console.log('[CloudflareProvider] terminate skipped, no sandbox id');
      return;
    }
    const id = this.sandboxId;
    console.log('[CloudflareProvider] terminate', id);
    try {
      await this.request(id, '', { method: 'DELETE' });
    } catch (error) {
      console.error('[CloudflareProvider] Failed to terminate sandbox:', error);
    }
    this.sandbox = null;
    this.sandboxInfo = null;
    this.sandboxId = null;
    this.existingFiles.clear();
  }

  isAlive(): boolean {
    return !!this.sandboxId;
  }

  private requireSandbox(): void {
    if (!this.sandboxId) {
      throw new Error('No active sandbox');
    }
  }

  private workerUrl(): string {
    const url =
      this.config.cloudflare?.workerUrl ||
      process.env.CLOUDFLARE_SANDBOX_URL ||
      '';
    if (!url) {
      throw new Error(
        'CLOUDFLARE_SANDBOX_URL is missing. Point it at the Worker that hosts CodeSandbox, for example https://code-market-builder.codemarket.workers.dev'
      );
    }
    return url.replace(/\/$/, '');
  }

  private secret(): string {
    const secret = this.config.cloudflare?.secret || process.env.CLOUDFLARE_SANDBOX_SECRET || '';
    if (!secret) {
      throw new Error('CLOUDFLARE_SANDBOX_SECRET is missing. Set the same value as the Worker secret.');
    }
    return secret;
  }

  private async request(sandboxId: string, path: string, init: RequestInit): Promise<Response> {
    const url = `${this.workerUrl()}/sandboxes/${sandboxId}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.secret()}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    console.log('[CloudflareProvider] HTTP', init.method || 'GET', url);
    const response = await fetch(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(appConfig.cloudflareSandbox.requestTimeoutMs)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[CloudflareProvider] HTTP error', {
        url,
        status: response.status,
        body: text.slice(0, 2000)
      });
      throw new Error(`Cloudflare sandbox ${init.method || 'GET'} ${path || '/'} failed (${response.status}): ${text}`);
    }
    return response;
  }

  private async requestJson<T>(sandboxId: string, path: string, init: RequestInit): Promise<T> {
    const response = await this.request(sandboxId, path, init);
    if (response.status === 204) {
      return {} as T;
    }
    return (await response.json()) as T;
  }
}
