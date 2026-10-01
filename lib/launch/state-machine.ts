import type {
  LaunchRequest,
  LaunchSnapshot,
  LaunchState,
} from './types';

const ALLOWED_TRANSITIONS: Record<LaunchState, ReadonlySet<LaunchState>> = {
  RECEIVED: new Set(['BASELINE_RUNNING', 'CANCELLED']),
  BASELINE_RUNNING: new Set(['GENERATING', 'WAITING_INFRA', 'RUNNING_DEGRADED', 'CANCELLED']),
  GENERATING: new Set(['PREPARING_CANDIDATE', 'REPAIRING', 'WAITING_INFRA', 'RUNNING_DEGRADED', 'CANCELLED']),
  PREPARING_CANDIDATE: new Set(['BUILDING', 'REPAIRING', 'WAITING_INFRA', 'RUNNING_DEGRADED', 'CANCELLED']),
  BUILDING: new Set(['SERVER_PROBING', 'REPAIRING', 'WAITING_INFRA', 'RUNNING_DEGRADED', 'CANCELLED']),
  SERVER_PROBING: new Set(['RUNTIME_PROBING', 'REPAIRING', 'WAITING_INFRA', 'RUNNING_DEGRADED', 'CANCELLED']),
  RUNTIME_PROBING: new Set(['RUNNING_EXACT', 'RUNNING_DEGRADED', 'REPAIRING', 'WAITING_INFRA', 'CANCELLED']),
  REPAIRING: new Set(['GENERATING', 'PREPARING_CANDIDATE', 'WAITING_INFRA', 'RUNNING_DEGRADED', 'CANCELLED']),
  WAITING_INFRA: new Set(['GENERATING', 'PREPARING_CANDIDATE', 'REPAIRING', 'RUNNING_DEGRADED', 'CANCELLED']),
  RUNNING_EXACT: new Set(['GENERATING', 'REPAIRING', 'CANCELLED']),
  RUNNING_DEGRADED: new Set(['GENERATING', 'REPAIRING', 'CANCELLED']),
  CANCELLED: new Set(),
};

// ─── Ariadne's Thread [AT-0020] ─────────────────────
// What: Create and transition launch snapshots through an explicit finite-state machine
// Why:  A launch error must select a recovery state instead of silently ending an ad-hoc client flow
// Date: 2026-09-30
// Related: [AT-0019] shared→lib/launch/types.ts:LaunchSnapshot, cloudflare/launch-run.ts:LaunchRun
// ─────────────────────────────────────────────────────
export function createLaunchSnapshot(
  runId: string,
  request: LaunchRequest,
  previewUrl: string,
  now: string = new Date().toISOString(),
): LaunchSnapshot {
  return {
    runId,
    request,
    state: 'RECEIVED',
    availability: 'starting',
    fidelity: 'baseline',
    revision: 0,
    sequence: 0,
    previewUrl,
    statusMessage: 'Launch request received.',
    recoveryHistory: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function canTransitionLaunch(from: LaunchState, to: LaunchState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].has(to);
}

export function transitionLaunch(
  current: LaunchSnapshot,
  target: LaunchState,
  patch: Partial<LaunchSnapshot> = {},
  now: string = new Date().toISOString(),
): LaunchSnapshot {
  if (!canTransitionLaunch(current.state, target)) {
    throw new Error(`Illegal launch transition: ${current.state} -> ${target}`);
  }

  return {
    ...current,
    ...patch,
    runId: current.runId,
    request: patch.request ?? current.request,
    state: target,
    sequence: current.sequence + 1,
    updatedAt: now,
  };
}

export function startLaunchRevision(
  current: LaunchSnapshot,
  request: LaunchRequest,
  now: string = new Date().toISOString(),
): LaunchSnapshot {
  if (current.state === 'CANCELLED') {
    throw new Error('Cancelled launch runs cannot accept a new revision');
  }

  return transitionLaunch(current, 'GENERATING', {
    request,
    revision: current.revision + 1,
    fidelity: 'exact',
    candidateUrl: undefined,
    candidateSandboxId: undefined,
    candidateProbeToken: undefined,
    checkpoint: undefined,
    lastFailure: undefined,
    statusMessage: 'Generating a candidate revision.',
  }, now);
}
