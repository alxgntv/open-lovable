import type {
  LaunchFailure,
  LaunchFailureKind,
  LaunchFidelity,
  LaunchRecoveryAction,
  LaunchRecoveryDecision,
  LaunchRecoveryRecord,
  LaunchState,
} from './types';

const RECOVERY_LADDERS: Record<LaunchFailureKind, LaunchRecoveryAction[]> = {
  'rate-limit': ['retry', 'fallback-model', 'publish-safe-baseline'],
  transport: ['retry', 'fallback-model', 'publish-safe-baseline'],
  'model-output': ['retry', 'fallback-model', 'regenerate', 'publish-safe-baseline'],
  'sandbox-missing': ['recreate-sandbox', 'retry', 'publish-safe-baseline'],
  dependency: ['retry', 'remove-dependencies', 'mock-integrations', 'publish-safe-baseline'],
  build: ['patch', 'regenerate', 'remove-dependencies', 'publish-safe-baseline'],
  process: ['retry', 'recreate-sandbox', 'publish-safe-baseline'],
  runtime: ['patch', 'regenerate', 'remove-dependencies', 'publish-safe-baseline'],
  'blank-root': ['patch', 'regenerate', 'publish-safe-baseline'],
  unknown: ['retry', 'regenerate', 'publish-safe-baseline'],
};

function normalizeFailureMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function fidelityForAction(action: LaunchRecoveryAction, current: LaunchFidelity): LaunchFidelity {
  if (action === 'remove-dependencies') return 'dependency-free';
  if (action === 'mock-integrations') return 'mocked';
  if (action === 'publish-safe-baseline') return 'baseline';
  return current;
}

// ─── Ariadne's Thread [AT-0021] ─────────────────────
// What: Classify failures and select a strictly escalating recovery action
// Why:  Repeating the same failed repair can loop forever without moving the product toward a runnable fallback
// Date: 2026-09-30
// Related: [AT-0019] shared→lib/launch/types.ts:LaunchFailure, [AT-0020] shared→lib/launch/state-machine.ts:transitionLaunch
// ─────────────────────────────────────────────────────
export function classifyLaunchFailure(
  message: string,
  phase: LaunchState,
  revision: number,
  options: { statusCode?: number; diagnostics?: string } = {},
): LaunchFailure {
  const normalized = normalizeFailureMessage(`${message}\n${options.diagnostics ?? ''}`);
  const statusCode = options.statusCode;
  let kind: LaunchFailureKind = 'unknown';

  if (statusCode === 429 || /\brate.?limit|too many requests|quota\b/.test(normalized)) {
    kind = 'rate-limit';
  } else if (/\btimeout|timed out|network|fetch failed|service unavailable|econn|socket|502|503|504\b/.test(normalized)) {
    kind = 'transport';
  } else if (/\bno active sandbox|sandbox.*missing|container.*not found|preview is not running\b/.test(normalized)) {
    kind = 'sandbox-missing';
  } else if (/\bnpm err|eresolve|package.*not found|cannot find package|dependency\b/.test(normalized)) {
    kind = 'dependency';
  } else if (/\bfailed to resolve import|syntaxerror|unexpected token|vite build|build failed|does not provide an export\b/.test(normalized)) {
    kind = 'build';
  } else if (/\bvite.*exited|process.*stopped|port.*not listening\b/.test(normalized)) {
    kind = 'process';
  } else if (/\bblank root|empty root|nothing rendered\b/.test(normalized)) {
    kind = 'blank-root';
  } else if (/\bunhandledrejection|referenceerror|typeerror|runtime error\b/.test(normalized)) {
    kind = 'runtime';
  } else if (/\bmalformed|truncated|generated no files|missing <file|invalid artifact\b/.test(normalized)) {
    kind = 'model-output';
  } else if (phase === 'RUNTIME_PROBING') {
    kind = 'runtime';
  }

  return {
    kind,
    fingerprint: `${kind}:${stableHash(`${phase}:${normalized}`)}`,
    message: message.slice(0, 12_000),
    phase,
    revision,
    occurredAt: new Date().toISOString(),
    statusCode,
    diagnostics: options.diagnostics?.slice(0, 12_000),
  };
}

export function decideLaunchRecovery(
  failure: LaunchFailure,
  existing: LaunchRecoveryRecord | undefined,
  currentFidelity: LaunchFidelity,
): LaunchRecoveryDecision {
  const used = new Set(existing?.actions ?? []);
  const ladder = RECOVERY_LADDERS[failure.kind];
  const action = ladder.find((candidate) => !used.has(candidate)) ?? 'publish-safe-baseline';
  const attempt = (existing?.attempts ?? 0) + 1;
  const retryDelay = Math.min(30_000, 750 * (2 ** Math.min(attempt - 1, 5)));

  return {
    action,
    delayMs: action === 'retry' || action === 'fallback-model' ? retryDelay : 0,
    fidelity: fidelityForAction(action, currentFidelity),
    reason: `Failure ${failure.fingerprint} escalated to ${action} on attempt ${attempt}.`,
  };
}

export function recordLaunchRecovery(
  failure: LaunchFailure,
  action: LaunchRecoveryAction,
  existing?: LaunchRecoveryRecord,
  now: string = new Date().toISOString(),
): LaunchRecoveryRecord {
  return {
    fingerprint: failure.fingerprint,
    actions: [...(existing?.actions ?? []), action],
    attempts: (existing?.attempts ?? 0) + 1,
    updatedAt: now,
  };
}
