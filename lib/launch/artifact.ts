import { injectRuntimeProbe } from './safe-baseline';
import type {
  LaunchArtifact,
  LaunchArtifactFile,
  LaunchFidelity,
} from './types';

const SAFE_FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!node_modules\/)[a-zA-Z0-9._/-]+$/;
const SAFE_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function defaultIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="AI-generated product preview" />
    <title>Product Preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.jsx"></script>
  </body>
</html>`;
}

function defaultMainJsx(appPath: string): string {
  const importPath = appPath.startsWith('src/')
    ? `./${appPath.slice('src/'.length)}`
    : `../${appPath}`;
  return `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '${importPath}';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);`;
}

function defaultIndexCss(): string {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root {
  min-height: 100%;
}

body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}`;
}

function parsePackages(generatedCode: string, explicitPackages: string[]): string[] {
  const packages = new Set(explicitPackages);
  for (const match of generatedCode.matchAll(/<package>([^<]+)<\/package>/gi)) {
    packages.add(match[1].trim());
  }
  for (const match of generatedCode.matchAll(/<packages>([^<]+)<\/packages>/gi)) {
    for (const name of match[1].split(/[\s,]+/)) packages.add(name.trim());
  }
  return [...packages].filter((name) => SAFE_PACKAGE.test(name));
}

// ─── Ariadne's Thread [AT-0023] ─────────────────────
// What: Convert model text into a complete, path-safe, versioned launch artifact
// Why:  The sandbox must never receive partial XML, path traversal, or a candidate without a bootable entrypoint
// Date: 2026-09-30
// Related: [AT-0019] shared→lib/launch/types.ts:LaunchArtifact, [AT-0022] shared→lib/launch/safe-baseline.ts:injectRuntimeProbe
// ─────────────────────────────────────────────────────
export function parseGeneratedArtifact(options: {
  generatedCode: string;
  revision: number;
  runId: string;
  packages?: string[];
  explanation?: string;
  model?: string;
  fidelity?: LaunchFidelity;
}): LaunchArtifact {
  const byPath = new Map<string, LaunchArtifactFile>();
  const filePattern = /<file\s+path=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/file>/gi;

  for (const match of options.generatedCode.matchAll(filePattern)) {
    const path = (match[1] || match[2] || '').trim().replace(/^\.\//, '');
    const content = match[3].replace(/^\n/, '').replace(/\n$/, '');
    if (!SAFE_FILE_PATH.test(path)) {
      throw new Error(`Invalid artifact path: ${path || '<empty>'}`);
    }
    if (!content.trim()) {
      throw new Error(`Invalid artifact: ${path} is empty`);
    }
    byPath.set(path, { path, content });
  }

  const applicationPath = [...byPath.keys()].find((path) => /(?:^|\/)App\.(?:jsx|tsx|js|ts)$/.test(path));
  if (!applicationPath) {
    throw new Error('Invalid artifact: generated no App file');
  }

  if (!byPath.has('src/main.jsx') && !byPath.has('src/main.tsx')) {
    byPath.set('src/main.jsx', { path: 'src/main.jsx', content: defaultMainJsx(applicationPath) });
  }
  if (!byPath.has('src/index.css')) {
    byPath.set('src/index.css', { path: 'src/index.css', content: defaultIndexCss() });
  }

  const indexFile = byPath.get('index.html') ?? { path: 'index.html', content: defaultIndexHtml() };
  const portableIndex = indexFile.content.replace(
    /(src|href)=(["'])\/src\//g,
    '$1=$2./src/',
  );
  const probeToken = crypto.randomUUID();
  byPath.set('index.html', {
    ...indexFile,
    content: injectRuntimeProbe(portableIndex, options.runId, options.revision, probeToken),
  });

  return {
    revision: options.revision,
    probeToken,
    files: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    packages: options.fidelity === 'dependency-free' || options.fidelity === 'baseline'
      ? []
      : parsePackages(options.generatedCode, options.packages ?? []),
    explanation: options.explanation,
    model: options.model,
    fidelity: options.fidelity ?? 'exact',
    createdAt: new Date().toISOString(),
  };
}
