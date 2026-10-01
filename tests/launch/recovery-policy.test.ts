import { describe, expect, it } from 'vitest';
import {
  classifyLaunchFailure,
  decideLaunchRecovery,
  recordLaunchRecovery,
} from '../../lib/launch/recovery-policy';
import type {
  LaunchFailure,
  LaunchRecoveryRecord,
} from '../../lib/launch/types';

// ─── Ariadne's Thread [AT-0058] ─────────────────────
// What: Fault-inject representative model, dependency, build, process, and browser failures
// Why:  Every repeated fingerprint must escalate to a runnable fallback instead of repeating one repair forever
// Date: 2026-09-30
// Related: [AT-0021] shared→lib/launch/recovery-policy.ts:decideLaunchRecovery, [AT-0040] infra→cloudflare/launch-run.ts:advanceRecovery
// ─────────────────────────────────────────────────────
describe('launch recovery policy', () => {
  it.each([
    ['HTTP 429 rate limit exceeded', 429, 'rate-limit'],
    ['Inference request timed out', undefined, 'transport'],
    ['Invalid artifact: generated no files', undefined, 'model-output'],
    ['No active sandbox', undefined, 'sandbox-missing'],
    ['npm ERR ERESOLVE dependency tree', undefined, 'dependency'],
    ['Vite build failed: Failed to resolve import', undefined, 'build'],
    ['Vite process stopped and port is not listening', undefined, 'process'],
    ['ReferenceError in browser runtime', undefined, 'runtime'],
    ['The candidate rendered a blank root', undefined, 'blank-root'],
    ['The application has no data-smoke-action interaction', undefined, 'runtime'],
  ])('classifies %s', (message, statusCode, expectedKind) => {
    const phase = message.includes('data-smoke-action') ? 'RUNTIME_PROBING' : 'BUILDING';
    expect(classifyLaunchFailure(
      message,
      phase,
      1,
      { statusCode },
    ).kind).toBe(expectedKind);
  });

  it('never repeats a recovery action for one dependency fingerprint', () => {
    const failure = classifyLaunchFailure(
      'npm ERR ERESOLVE dependency tree',
      'BUILDING',
      1,
    );
    let record: LaunchRecoveryRecord | undefined;
    const actions: string[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const decision = decideLaunchRecovery(failure, record, 'exact');
      actions.push(decision.action);
      record = recordLaunchRecovery(failure, decision.action, record);
    }

    expect(actions).toEqual([
      'retry',
      'remove-dependencies',
      'mock-integrations',
      'publish-safe-baseline',
    ]);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it.each([
    'rate-limit',
    'transport',
    'model-output',
    'sandbox-missing',
    'dependency',
    'build',
    'process',
    'runtime',
    'blank-root',
    'unknown',
  ] as const)('eventually publishes a safe baseline for %s', (kind) => {
    const failure: LaunchFailure = {
      kind,
      fingerprint: `${kind}:fault`,
      message: 'Injected fault',
      phase: 'BUILDING',
      revision: 1,
      occurredAt: '2026-09-30T00:00:00.000Z',
    };
    let record: LaunchRecoveryRecord | undefined;
    let finalAction = '';

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const decision = decideLaunchRecovery(failure, record, 'exact');
      finalAction = decision.action;
      record = recordLaunchRecovery(failure, decision.action, record);
      if (decision.action === 'publish-safe-baseline') break;
    }

    expect(finalAction).toBe('publish-safe-baseline');
  });

  it('normalizes volatile ids and numbers into a stable fingerprint', () => {
    const first = classifyLaunchFailure(
      'Request 123 timed out for https://api.example/a token abcdef123456',
      'GENERATING',
      1,
    );
    const second = classifyLaunchFailure(
      'Request 999 timed out for https://api.example/b token fedcba654321',
      'GENERATING',
      1,
    );
    expect(first.fingerprint).toBe(second.fingerprint);
  });
});
