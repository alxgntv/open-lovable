import { describe, expect, it } from 'vitest';
import {
  canTransitionLaunch,
  createLaunchSnapshot,
  startLaunchRevision,
  transitionLaunch,
} from '../../lib/launch/state-machine';
import { LAUNCH_STATES } from '../../lib/launch/types';

const request = {
  prompt: 'Build an interactive analytics dashboard',
  model: 'test/model-a',
  idempotencyKey: 'request-1',
};

// ─── Ariadne's Thread [AT-0057] ─────────────────────
// What: Verify launch availability, transition safety, and revision isolation invariants
// Why:  Refactors must never reintroduce a terminal failure state or overwrite last-known-good preview identity
// Date: 2026-09-30
// Related: [AT-0020] shared→lib/launch/state-machine.ts:transitionLaunch, [AT-0019] shared→lib/launch/types.ts:LAUNCH_STATES
// ─────────────────────────────────────────────────────
describe('launch state machine', () => {
  it('contains no terminal FAILED state', () => {
    expect(LAUNCH_STATES).not.toContain('FAILED');
  });

  it('publishes baseline availability before candidate work', () => {
    const received = createLaunchSnapshot(
      'lr-teststate01',
      request,
      'https://worker.test/launch-runs/lr-teststate01/preview/',
      '2026-09-30T00:00:00.000Z',
    );
    const baseline = transitionLaunch(received, 'BASELINE_RUNNING', {
      availability: 'running',
      fidelity: 'baseline',
      statusMessage: 'Safe preview is running.',
    }, '2026-09-30T00:00:01.000Z');

    expect(baseline.availability).toBe('running');
    expect(baseline.previewUrl).toBe(received.previewUrl);
    expect(baseline.sequence).toBe(1);
  });

  it('keeps the active sandbox while an isolated revision starts', () => {
    const received = createLaunchSnapshot('lr-teststate02', request, 'https://worker.test/preview/');
    const baseline = transitionLaunch(received, 'BASELINE_RUNNING', { availability: 'running' });
    const generating = startLaunchRevision(baseline, request);
    const preparing = transitionLaunch(generating, 'PREPARING_CANDIDATE');
    const building = transitionLaunch(preparing, 'BUILDING', {
      activeSandboxId: 'last-known-good',
      candidateSandboxId: 'candidate-r1',
    });

    expect(building.activeSandboxId).toBe('last-known-good');
    expect(building.candidateSandboxId).toBe('candidate-r1');
    expect(building.availability).toBe('running');
  });

  it('accepts a new request only as a new revision', () => {
    const received = createLaunchSnapshot('lr-teststate03', request, 'https://worker.test/preview/');
    const baseline = transitionLaunch(received, 'BASELINE_RUNNING', { availability: 'running' });
    const nextRequest = {
      prompt: 'Add a billing page',
      idempotencyKey: 'request-2',
    };
    const revision = startLaunchRevision(baseline, nextRequest);

    expect(revision.revision).toBe(1);
    expect(revision.request).toEqual(nextRequest);
    expect(revision.fidelity).toBe('exact');
  });

  it('rejects illegal shortcuts around validation', () => {
    expect(canTransitionLaunch('GENERATING', 'RUNNING_EXACT')).toBe(false);
    const received = createLaunchSnapshot('lr-teststate04', request, 'https://worker.test/preview/');
    expect(() => transitionLaunch(received, 'RUNNING_EXACT')).toThrow(
      'Illegal launch transition: RECEIVED -> RUNNING_EXACT',
    );
  });
});
