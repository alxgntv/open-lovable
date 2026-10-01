import { NextResponse } from 'next/server';
import { sandboxManager } from '@/lib/sandbox/sandbox-manager';

export const dynamic = 'force-dynamic';

const PROCESS_MARKERS = [
  'Preview is not running',
  'The service is no longer running',
  'The service was stopped',
  'Outdated Optimize Dep',
  'Network connection lost',
];

const CODE_MARKERS = [
  'Failed to resolve import',
  'Parse error',
  'Unexpected token',
  'SyntaxError',
  'Pre-transform error',
  'does not provide an export',
];

declare global {
  var activeSandboxProvider: any;
}

type ModuleResult = { path: string; status: number; body: string };

function localImports(body: string, fromPath: string): string[] {
  const found = new Set<string>();
  const pattern = /from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const spec = match[1];
    if (spec.startsWith('.')) {
      const dir = fromPath.split('/').slice(0, -1);
      const parts = [...dir, ...spec.split('/')];
      const stack: string[] = [];
      for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
      }
      let resolved = stack.join('/');
      if (!/\.(jsx|js|tsx|ts|css)$/.test(resolved)) resolved += '.jsx';
      found.add(resolved);
    } else if (spec.includes('/src/')) {
      found.add(spec.slice(spec.indexOf('src/')));
    }
  }
  return [...found];
}

function failedMarker(text: string): string | undefined {
  return [...PROCESS_MARKERS, ...CODE_MARKERS].find((item) => text.includes(item));
}

function failureKind(text: string): 'process' | 'code' | null {
  if (PROCESS_MARKERS.some((item) => text.includes(item))) return 'process';
  if (CODE_MARKERS.some((item) => text.includes(item))) return 'code';
  return null;
}

async function readModule(previewUrl: string, path: string): Promise<ModuleResult> {
  const base = previewUrl.endsWith('/') ? previewUrl : `${previewUrl}/`;
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  console.log('[preview-status] Module', { path, status: response.status, bytes: body.length });
  return { path, status: response.status, body };
}

// ─── Ariadne's Thread [AT-0018] ─────────────────────
// What: Walk the Vite module graph and the dev-server log
// Why:  HTTP 200 on the shell is not a running app
// Date: 2026-09-30
// Related: app/generation/page.tsx:drivePreviewUntilRunning
// ─────────────────────────────────────────────────────
export async function GET() {
  const provider = sandboxManager.getActiveProvider() || global.activeSandboxProvider;
  if (!provider) {
    console.log('[preview-status] No active sandbox provider');
    return NextResponse.json({ ok: false, failureKind: 'missing', error: 'No active sandbox' });
  }

  const info = typeof provider.getSandboxInfo === 'function' ? provider.getSandboxInfo() : null;
  const url = info?.url as string | undefined;
  console.log('[preview-status] Checking preview', { sandboxId: info?.sandboxId, url });

  let log = '';
  try {
    const result = await provider.runCommand('tail -n 200 /tmp/dev-server.log || true');
    log = [result?.stdout, result?.stderr].filter(Boolean).join('\n');
    console.log('[preview-status] Vite log bytes', log.length, 'exit', result?.exitCode);
  } catch (error) {
    log = error instanceof Error ? error.message : String(error);
    console.error('[preview-status] Failed to read Vite log:', error);
  }

  if (!url) {
    console.error('[preview-status] Preview URL is missing');
    return NextResponse.json({ ok: false, error: 'Preview URL is missing', log });
  }

  try {
    const page = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    const html = await page.text();
    const modules: ModuleResult[] = [];
    const queue = ['src/main.jsx'];
    const seen = new Set<string>();
    while (queue.length > 0 && modules.length < 25) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const loaded = await readModule(url, path);
      modules.push(loaded);
      if (loaded.status < 400 && !failedMarker(loaded.body)) {
        for (const next of localImports(loaded.body, path)) queue.push(next);
      }
    }

    const current = `${html}\n${modules.map((item) => item.body).join('\n')}`;
    const kind = failureKind(current);
    const badModule = modules.find((item) => item.status >= 400 || failedMarker(item.body) || item.body.trim().startsWith('<!DOCTYPE') || item.body.trim().startsWith('<html'));
    const sawApp = modules.some((item) => item.path.endsWith('App.jsx') || item.path.endsWith('App.tsx'));
    const ok = page.status < 400 && !kind && !badModule && sawApp && modules.length > 1;
    // ─── Ariadne's Thread [AT-0024] ─────────────────────
    // What: Use the collected preview evidence when the failing module has no body
    // Why:  The undefined evidence identifier crashed readiness checks instead of returning diagnostics to recovery
    // Date: 2026-09-30
    // Related: [AT-0018] app/api/preview-status/route.ts:GET, [AT-0021] shared→lib/launch/recovery-policy.ts:classifyLaunchFailure
    // ─────────────────────────────────────────────────────
    const summary = ok
      ? ''
      : kind === 'process'
        ? `Vite process stopped while compiling ${badModule?.path || 'the app'}. This is not a source error.`
        : `${badModule?.path || 'preview'} failed to compile. ${failedMarker(badModule?.body || current) || `HTTP ${badModule?.status || page.status}`}`;
    console.log('[preview-status] Result', {
      ok,
      failureKind: kind,
      pageStatus: page.status,
      modules: modules.map((item) => `${item.path}:${item.status}`),
      sawApp,
      summary,
    });
    return NextResponse.json({
      ok,
      failureKind: kind,
      status: page.status,
      modules: modules.map((item) => ({ path: item.path, status: item.status })),
      error: summary,
      log: log.slice(-2000),
      url,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[preview-status] Preview request failed:', message);
    return NextResponse.json({ ok: false, error: message, log: log.slice(-4000), url });
  }
}
