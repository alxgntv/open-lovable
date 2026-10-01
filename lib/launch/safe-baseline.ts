const PROBE_START = '<!-- open-lovable-runtime-probe:start -->';
const PROBE_END = '<!-- open-lovable-runtime-probe:end -->';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortProductName(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'New product';
  return firstLine.replace(/\s+/g, ' ').slice(0, 72);
}

// ─── Ariadne's Thread [AT-0022] ─────────────────────
// What: Generate the dependency-free baseline and inject a browser runtime proof into candidate HTML
// Why:  A known-good preview must exist before probabilistic generation starts, and promotion requires real DOM evidence
// Date: 2026-09-30
// Related: [AT-0019] shared→lib/launch/types.ts:LaunchRuntimeReport, cloudflare/launch-run.ts:LaunchRun
// ─────────────────────────────────────────────────────
export function createRuntimeProbeScript(
  runId: string,
  revision: number,
  probeToken: string = crypto.randomUUID(),
): string {
  const identity = JSON.stringify({ runId, revision, probeToken });
  return `${PROBE_START}
<script>
(() => {
  const identity = ${identity};
  const report = (status, details = {}) => {
    window.parent.postMessage({
      source: 'open-lovable-runtime-probe',
      ...identity,
      status,
      idempotencyKey: identity.runId + ':' + identity.revision + ':' + identity.probeToken + ':' + status,
      ...details,
    }, '*');
  };
  let runtimeFailure = null;
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    originalConsoleError(...args);
    if (runtimeFailure) return;
    runtimeFailure = {
      message: args.map((value) => value && value.message ? value.message : String(value)).join(' '),
      stack: args.find((value) => value && value.stack)?.stack,
    };
    report('error', runtimeFailure);
  };
  window.addEventListener('error', (event) => {
    runtimeFailure = {
      message: event.message || 'Unknown runtime error',
      stack: event.error && event.error.stack ? String(event.error.stack) : undefined,
    };
    report('error', runtimeFailure);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    runtimeFailure = {
      message: reason && reason.message ? String(reason.message) : String(reason || 'Unhandled promise rejection'),
      stack: reason && reason.stack ? String(reason.stack) : undefined,
    };
    report('error', runtimeFailure);
  });
  report('boot');
  window.addEventListener('DOMContentLoaded', () => {
    window.setTimeout(() => {
      if (runtimeFailure) return;
      const root = document.getElementById('root');
      const rootChildCount = root ? root.childElementCount : 0;
      const visibleText = root && root.textContent ? root.textContent.trim() : '';
      const rootRect = root ? root.getBoundingClientRect() : null;
      const rootStyle = root ? window.getComputedStyle(root) : null;
      const visiblyRendered = Boolean(
        rootRect
        && rootRect.width > 0
        && rootRect.height > 0
        && rootStyle
        && rootStyle.display !== 'none'
        && rootStyle.visibility !== 'hidden'
        && rootStyle.opacity !== '0'
      );
      if (!root || !visiblyRendered || (rootChildCount === 0 && visibleText.length === 0)) {
        report('blank-root', { message: 'The application root is empty or not visible.', rootChildCount });
        return;
      }
      const smokeAction = root.querySelector('[data-smoke-action]');
      if (!smokeAction || typeof smokeAction.click !== 'function') {
        report('error', { message: 'The application has no data-smoke-action interaction.', rootChildCount });
        return;
      }
      const smokeBefore = document.body.innerHTML;
      smokeAction.click();
      window.setTimeout(() => {
        if (runtimeFailure) return;
        if (document.body.innerHTML === smokeBefore) {
          report('error', { message: 'The data-smoke-action interaction did not change visible UI.', rootChildCount });
          return;
        }
        report('ready', { rootChildCount });
      }, 300);
    }, 1500);
  }, { once: true });
})();
</script>
${PROBE_END}`;
}

export function injectRuntimeProbe(
  html: string,
  runId: string,
  revision: number,
  probeToken?: string,
): string {
  const withoutOldProbe = html.replace(
    new RegExp(`${PROBE_START}[\\s\\S]*?${PROBE_END}`, 'g'),
    '',
  );
  const probe = createRuntimeProbeScript(runId, revision, probeToken);
  if (withoutOldProbe.includes('</head>')) {
    return withoutOldProbe.replace('</head>', `${probe}\n</head>`);
  }
  return `${probe}\n${withoutOldProbe}`;
}

export function createSafeBaselineHtml(prompt: string, runId: string): string {
  const productName = escapeHtml(shortProductName(prompt));
  const productBrief = escapeHtml(prompt.trim().slice(0, 700) || 'Interactive product preview');
  const probe = createRuntimeProbeScript(runId, 0, 'safe-baseline');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${productBrief}" />
    <title>${productName}</title>
    ${probe}
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; color: #f8fafc; background: radial-gradient(circle at top, #1e293b 0, #020617 58%); }
      main { min-height: 100vh; display: grid; place-items: center; padding: 32px; }
      section { width: min(720px, 100%); padding: 40px; border: 1px solid rgba(148, 163, 184, .25); border-radius: 24px; background: rgba(15, 23, 42, .78); box-shadow: 0 30px 80px rgba(0, 0, 0, .35); backdrop-filter: blur(18px); }
      .eyebrow { margin: 0 0 12px; color: #38bdf8; font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(32px, 7vw, 64px); line-height: 1.03; letter-spacing: -.04em; }
      .brief { margin: 22px 0 30px; color: #cbd5e1; font-size: 17px; line-height: 1.7; white-space: pre-wrap; }
      button { border: 0; border-radius: 999px; padding: 13px 20px; color: #082f49; background: #7dd3fc; font: inherit; font-weight: 800; cursor: pointer; }
      button:hover { background: #bae6fd; }
      #status { min-height: 24px; margin: 18px 0 0; color: #86efac; }
    </style>
  </head>
  <body>
    <main id="root">
      <section>
        <p class="eyebrow">Running safe preview</p>
        <h1>${productName}</h1>
        <p class="brief">${productBrief}</p>
        <button id="prototype-action" data-smoke-action type="button">Try the prototype</button>
        <p id="status" role="status"></p>
      </section>
    </main>
    <script>
      document.getElementById('prototype-action').addEventListener('click', () => {
        document.getElementById('status').textContent = 'The interactive preview is running while the full version is being prepared.';
      });
    </script>
  </body>
</html>`;
}
