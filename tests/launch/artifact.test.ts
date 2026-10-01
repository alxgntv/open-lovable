import { describe, expect, it } from 'vitest';
import { parseGeneratedArtifact } from '../../lib/launch/artifact';
import { createSafeBaselineHtml } from '../../lib/launch/safe-baseline';

const appFile = `<file path="src/App.jsx">
export default function App() {
  return <button type="button">Launch product</button>;
}
</file>`;

// ─── Ariadne's Thread [AT-0059] ─────────────────────
// What: Validate safe artifact completion, path isolation, dependency degradation, and runtime probe injection
// Why:  Model text must become a deterministic bootable candidate before any sandbox file is changed
// Date: 2026-09-30
// Related: [AT-0023] shared→lib/launch/artifact.ts:parseGeneratedArtifact, [AT-0022] shared→lib/launch/safe-baseline.ts:createSafeBaselineHtml
// ─────────────────────────────────────────────────────
describe('launch artifact', () => {
  it('completes mandatory Vite entry files and injects runtime proof', () => {
    const artifact = parseGeneratedArtifact({
      generatedCode: `${appFile}\n<package>lucide-react</package>`,
      revision: 1,
      runId: 'lr-artifact01',
      fidelity: 'exact',
    });

    expect(artifact.files.map((file) => file.path)).toEqual([
      'index.html',
      'src/App.jsx',
      'src/index.css',
      'src/main.jsx',
    ]);
    expect(artifact.packages).toEqual(['lucide-react']);
    expect(artifact.probeToken).toBeTruthy();
    expect(artifact.files.find((file) => file.path === 'index.html')?.content)
      .toContain('open-lovable-runtime-probe');
  });

  it('removes additional packages at dependency-free degradation', () => {
    const artifact = parseGeneratedArtifact({
      generatedCode: `${appFile}\n<packages>lucide-react, framer-motion</packages>`,
      revision: 2,
      runId: 'lr-artifact02',
      packages: ['another-package'],
      fidelity: 'dependency-free',
    });
    expect(artifact.packages).toEqual([]);
  });

  it('rejects path traversal before sandbox writes', () => {
    expect(() => parseGeneratedArtifact({
      generatedCode: `${appFile}\n<file path="../escape.js">bad</file>`,
      revision: 1,
      runId: 'lr-artifact03',
      fidelity: 'exact',
    })).toThrow('Invalid artifact path');
  });

  it('rejects output without an application root', () => {
    expect(() => parseGeneratedArtifact({
      generatedCode: '<file path="src/Widget.jsx">export default function Widget() { return null; }</file>',
      revision: 1,
      runId: 'lr-artifact04',
      fidelity: 'exact',
    })).toThrow('generated no App file');
  });

  it('normalizes absolute source asset paths for prefixed previews', () => {
    const artifact = parseGeneratedArtifact({
      generatedCode: `${appFile}
<file path="index.html"><div id="root"></div><script type="module" src="/src/main.jsx"></script></file>`,
      revision: 1,
      runId: 'lr-artifact05',
      fidelity: 'exact',
    });
    expect(artifact.files.find((file) => file.path === 'index.html')?.content)
      .toContain('src="./src/main.jsx"');
  });
});

describe('safe baseline', () => {
  it('is self-contained, interactive, and runtime-probed', () => {
    const html = createSafeBaselineHtml(
      'Build a customer support dashboard',
      'lr-baseline01',
    );
    expect(html).toContain('Running safe preview');
    expect(html).toContain('Try the prototype');
    expect(html).toContain('data-smoke-action');
    expect(html).toContain("window.parent.postMessage");
    expect(html).toContain('id="root"');
    expect(html).not.toContain('<img');
  });
});
