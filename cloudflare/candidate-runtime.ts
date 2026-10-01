import type { LaunchArtifact } from '../lib/launch/types';
import type { CodeSandbox, PreviewResult, SandboxExecResult } from './code-sandbox';

const WORKSPACE = '/workspace/app';
const RESERVED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'vite.config.js',
  'vite.config.ts',
  'tailwind.config.js',
  'tailwind.config.ts',
  'postcss.config.js',
  'postcss.config.cjs',
]);

export interface CandidateRuntimeResult {
  sandboxId: string;
  build: SandboxExecResult;
  preview: PreviewResult;
  probeStatus: number;
  moduleCount: number;
}

const MODULE_FAILURE_MARKERS = [
  'Failed to resolve import',
  'Pre-transform error',
  'SyntaxError',
  'Unexpected token',
  'does not provide an export',
];

// ─── Ariadne's Thread [AT-0066] ─────────────────────
// What: Pin candidate builds to the verified Vite 7 and esbuild 0.28 toolchain
// Why:  esbuild 0.18 crashes on the current LinuxKit kernel with lfstack.push invalid packing
// Date: 2026-09-30
// Related: [AT-0031] cloudflare/candidate-runtime.ts:buildCandidateRuntime, [AT-0007] infra→cloudflare/sandbox.Dockerfile
// ─────────────────────────────────────────────────────
function packageJson(): string {
  return JSON.stringify({
    name: 'open-lovable-candidate',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite --host 0.0.0.0 --port 5173 --strictPort',
      build: 'vite build',
    },
    dependencies: {
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
    devDependencies: {
      '@vitejs/plugin-react': '5.2.0',
      autoprefixer: '10.4.21',
      esbuild: '0.28.1',
      postcss: '8.5.6',
      tailwindcss: '3.4.17',
      vite: '7.3.6',
    },
  }, null, 2);
}

function viteConfig(sandboxId: string): string {
  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: ${JSON.stringify(`/previews/${sandboxId}/`)},
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    hmr: false,
    allowedHosts: true,
  },
});`;
}

function tailwindConfig(): string {
  return `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};`;
}

function postcssConfig(): string {
  return `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};`;
}

export function getCandidateSandboxId(runId: string, revision: number): string {
  const safeRun = runId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 45);
  return `cand-${safeRun}-r${revision}`.slice(0, 63).replace(/-$/, '');
}

function resolveModulePath(fromPath: string, specifier: string, previewBase: string): string | null {
  if (specifier.startsWith(`${previewBase}src/`)) return specifier;
  if (specifier.startsWith('/src/')) return `${previewBase}${specifier.slice(1)}`;
  if (!specifier.startsWith('.')) return null;
  const base = new URL(fromPath, 'http://candidate');
  const resolved = new URL(specifier, base);
  if (!/\.(?:js|jsx|ts|tsx|css)$/.test(resolved.pathname)) resolved.pathname += '.jsx';
  return resolved.pathname;
}

// ─── Ariadne's Thread [AT-0041] ─────────────────────
// What: Walk the live Vite module graph after the production build
// Why:  A listening HTTP port can still return transformed compile errors or HTML fallbacks for missing modules
// Date: 2026-09-30
// Related: [AT-0018] backend→app/api/preview-status/route.ts:GET, [AT-0031] cloudflare/candidate-runtime.ts:buildCandidateRuntime
// ─────────────────────────────────────────────────────
async function probeModuleGraph(
  sandbox: DurableObjectStub<CodeSandbox>,
  sandboxId: string,
  entryFile: string,
): Promise<number> {
  const previewBase = `/previews/${sandboxId}/`;
  const queue = [`${previewBase}${entryFile.replace(/^\//, '')}`];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < 40) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const response = await sandbox.fetch(new Request(`http://container${path}`));
    const body = await response.text();
    const marker = MODULE_FAILURE_MARKERS.find((candidate) => body.includes(candidate));
    const htmlFallback = /^\s*(?:<!doctype|<html)/i.test(body);
    console.log('[candidate-runtime] Module probe', {
      path,
      status: response.status,
      bytes: body.length,
      marker,
      htmlFallback,
    });
    if (response.status >= 400 || marker || htmlFallback) {
      throw new Error(
        `Candidate module graph failed at ${path}: ${marker || `HTTP ${response.status}${htmlFallback ? ' HTML fallback' : ''}`}`,
      );
    }
    const importPattern = /(?:from\s+|import\s*)['"]([^'"]+)['"]/g;
    for (const match of body.matchAll(importPattern)) {
      const resolved = resolveModulePath(path, match[1], previewBase);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  if (seen.size < 2) {
    throw new Error(`Candidate module graph is incomplete: loaded ${seen.size} module`);
  }
  return seen.size;
}

// ─── Ariadne's Thread [AT-0031] ─────────────────────
// What: Build every generated revision in a deterministic isolated candidate sandbox
// Why:  Broken files, dependencies, or processes must never replace the active last-known-good preview
// Date: 2026-09-30
// Related: [AT-0008] infra→cloudflare/code-sandbox.ts:CodeSandbox, [AT-0023] shared→lib/launch/artifact.ts:parseGeneratedArtifact, [AT-0025] infra→cloudflare/launch-run.ts:LaunchRun
// ─────────────────────────────────────────────────────
export async function buildCandidateRuntime(options: {
  runId: string;
  artifact: LaunchArtifact;
  sandboxNamespace: DurableObjectNamespace<CodeSandbox>;
  publicOrigin: string;
}): Promise<CandidateRuntimeResult> {
  const { runId, artifact, sandboxNamespace, publicOrigin } = options;
  const sandboxId = getCandidateSandboxId(runId, artifact.revision);
  const sandbox = sandboxNamespace.getByName(sandboxId);
  console.log('[candidate-runtime] Preparing isolated candidate', {
    runId,
    revision: artifact.revision,
    sandboxId,
    files: artifact.files.length,
    packages: artifact.packages,
  });

  await sandbox.startSession(sandboxId);
  const reset = await sandbox.exec(
    [
      'sh',
      '-c',
      `pkill -f '[e]sbuild' || true; pkill -f '[v]ite' || true; rm -rf ${WORKSPACE}/dist ${WORKSPACE}/src ${WORKSPACE}/node_modules/.vite && mkdir -p ${WORKSPACE}/src`,
    ],
    WORKSPACE,
  );
  if (reset.exitCode !== 0) {
    throw new Error(`Candidate workspace reset failed: ${reset.stderr || reset.stdout}`);
  }

  await Promise.all([
    sandbox.writeFile('package.json', packageJson()),
    sandbox.writeFile('vite.config.js', viteConfig(sandboxId)),
    sandbox.writeFile('tailwind.config.js', tailwindConfig()),
    sandbox.writeFile('postcss.config.js', postcssConfig()),
  ]);

  for (const file of artifact.files) {
    if (RESERVED_FILES.has(file.path)) {
      console.log('[candidate-runtime] Ignoring model-owned runtime config', {
        runId,
        revision: artifact.revision,
        path: file.path,
      });
      continue;
    }
    await sandbox.writeFile(file.path, file.content);
  }

  if (artifact.packages.length > 0) {
    const install = await sandbox.exec([
      'timeout',
      '480',
      'npm',
      'install',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
      ...artifact.packages,
    ], WORKSPACE);
    console.log('[candidate-runtime] Dependency installation finished', {
      runId,
      revision: artifact.revision,
      exitCode: install.exitCode,
      stdoutBytes: install.stdout.length,
      stderrBytes: install.stderr.length,
    });
    if (install.exitCode !== 0) {
      throw new Error(`Candidate dependency installation failed: ${install.stderr || install.stdout}`);
    }
  }

  const build = await sandbox.exec(['timeout', '180', 'npm', 'run', 'build'], WORKSPACE);
  console.log('[candidate-runtime] Production build finished', {
    runId,
    revision: artifact.revision,
    exitCode: build.exitCode,
    stdoutBytes: build.stdout.length,
    stderrBytes: build.stderr.length,
  });
  if (build.exitCode !== 0) {
    throw new Error(`Candidate production build failed: ${build.stderr || build.stdout}`);
  }

  const previewUrl = `${publicOrigin.replace(/\/$/, '')}/previews/${sandboxId}/`;
  const preview = await sandbox.startPreview(sandboxId, previewUrl);
  if (preview.status !== 'ready') {
    const details = preview.status === 'exited'
      ? `exit ${preview.exitCode}: ${preview.log}`
      : preview.log;
    throw new Error(`Candidate Vite process failed: ${details}`);
  }

  const probe = await sandbox.fetch(new Request(`http://container/previews/${sandboxId}/`));
  await probe.body?.cancel();
  console.log('[candidate-runtime] Server probe finished', {
    runId,
    revision: artifact.revision,
    sandboxId,
    status: probe.status,
  });
  if (probe.status >= 400) {
    throw new Error(`Candidate server probe failed with HTTP ${probe.status}`);
  }
  const entryPath = artifact.files.some((file) => file.path === 'src/main.tsx')
    ? 'src/main.tsx'
    : 'src/main.jsx';
  const moduleCount = await probeModuleGraph(sandbox, sandboxId, entryPath);
  console.log('[candidate-runtime] Module graph probe passed', {
    runId,
    revision: artifact.revision,
    sandboxId,
    moduleCount,
  });

  return {
    sandboxId,
    build,
    preview,
    probeStatus: probe.status,
    moduleCount,
  };
}
