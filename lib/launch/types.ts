// ─── Ariadne's Thread [AT-0019] ─────────────────────
// What: Define the shared contract for durable product launch runs
// Why:  UI, Next.js routes, Worker orchestration, and sandbox recovery must agree on one state model
// Date: 2026-09-30
// Related: [AT-0018] backend→app/api/preview-status/route.ts:GET, [AT-0008] infra→cloudflare/code-sandbox.ts:CodeSandbox
// ─────────────────────────────────────────────────────

export const LAUNCH_STATES = [
  'RECEIVED',
  'BASELINE_RUNNING',
  'GENERATING',
  'PREPARING_CANDIDATE',
  'BUILDING',
  'SERVER_PROBING',
  'RUNTIME_PROBING',
  'REPAIRING',
  'WAITING_INFRA',
  'RUNNING_EXACT',
  'RUNNING_DEGRADED',
  'CANCELLED',
] as const;

export type LaunchState = (typeof LAUNCH_STATES)[number];
export type LaunchAvailability = 'starting' | 'running';
export type LaunchFidelity = 'baseline' | 'exact' | 'mocked' | 'dependency-free';
export type LaunchFailureKind =
  | 'rate-limit'
  | 'transport'
  | 'model-output'
  | 'sandbox-missing'
  | 'dependency'
  | 'build'
  | 'process'
  | 'runtime'
  | 'blank-root'
  | 'unknown';

export type LaunchRecoveryAction =
  | 'retry'
  | 'fallback-model'
  | 'recreate-sandbox'
  | 'patch'
  | 'regenerate'
  | 'remove-dependencies'
  | 'mock-integrations'
  | 'publish-safe-baseline';

export interface LaunchRequest {
  prompt: string;
  model?: string;
  sourceUrl?: string;
  context?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface LaunchArtifactFile {
  path: string;
  content: string;
}

export interface LaunchArtifact {
  revision: number;
  probeToken: string;
  files: LaunchArtifactFile[];
  packages: string[];
  explanation?: string;
  model?: string;
  fidelity: LaunchFidelity;
  createdAt: string;
}

export interface LaunchFailure {
  kind: LaunchFailureKind;
  fingerprint: string;
  message: string;
  phase: LaunchState;
  revision: number;
  occurredAt: string;
  statusCode?: number;
  diagnostics?: string;
}

export interface LaunchCheckpoint {
  id: string;
  phase: LaunchState;
  status: 'started' | 'completed';
  attempt: number;
  idempotencyKey: string;
  startedAt: string;
  completedAt?: string;
}

export interface LaunchRecoveryRecord {
  fingerprint: string;
  actions: LaunchRecoveryAction[];
  attempts: number;
  updatedAt: string;
}

export interface LaunchSnapshot {
  runId: string;
  request: LaunchRequest;
  state: LaunchState;
  availability: LaunchAvailability;
  fidelity: LaunchFidelity;
  revision: number;
  sequence: number;
  previewUrl: string;
  candidateUrl?: string;
  candidateSandboxId?: string;
  candidateProbeToken?: string;
  activeSandboxId?: string;
  activeProbeToken?: string;
  previousSandboxId?: string;
  previousProbeToken?: string;
  statusMessage: string;
  checkpoint?: LaunchCheckpoint;
  lastFailure?: LaunchFailure;
  recoveryHistory: Record<string, LaunchRecoveryRecord>;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchEvent {
  sequence: number;
  type: string;
  timestamp: string;
  message: string;
  snapshot: LaunchSnapshot;
}

export interface LaunchRuntimeReport {
  runId: string;
  revision: number;
  status: 'boot' | 'ready' | 'error' | 'blank-root';
  message?: string;
  stack?: string;
  rootChildCount?: number;
  probeToken?: string;
  idempotencyKey: string;
}

export interface LaunchEventsResponse {
  events: LaunchEvent[];
  latestSequence: number;
}

export interface LaunchRecoveryDecision {
  action: LaunchRecoveryAction;
  delayMs: number;
  fidelity: LaunchFidelity;
  reason: string;
}

export function isLaunchRunning(snapshot: LaunchSnapshot | null | undefined): boolean {
  return snapshot?.availability === 'running';
}

export function isLaunchSettled(snapshot: LaunchSnapshot | null | undefined): boolean {
  return snapshot?.state === 'RUNNING_EXACT'
    || snapshot?.state === 'RUNNING_DEGRADED'
    || snapshot?.state === 'CANCELLED';
}
