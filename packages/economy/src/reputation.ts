export const REPUTATION_MIN = 0;
export const REPUTATION_MAX = 100;
export const REPUTATION_INITIAL = 50;

/** Reputation deltas per outcome, as fixed in docs/ARCHITECTURE.md. */
export const REPUTATION_DELTAS = {
  SERVICE_SUCCESS_SELLER: 1,
  SERVICE_SUCCESS_BUYER: 0.25,
  SERVICE_FAILED_SELLER: -3,
  JOB_COMPLETED_WORKER: 2,
  JOB_COMPLETED_POSTER: 1,
  JOB_FAILED_WORKER: -3,
  PAYMENT_FAILED_BUYER: -1,
  PAYMENT_DENIED_BUYER: -0.5,
} as const;

export type ReputationEventKind = keyof typeof REPUTATION_DELTAS;

export const reputationKinds = Object.keys(REPUTATION_DELTAS) as ReputationEventKind[];

export function isReputationEventKind(value: unknown): value is ReputationEventKind {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(REPUTATION_DELTAS, value)
  );
}

export interface ReputationUpdate {
  /** New score, clamped to 0..100. */
  readonly next: number;
  /** Effective change actually applied (after clamping). */
  readonly delta: number;
}

export function clampReputation(value: number): number {
  if (Number.isNaN(value)) return REPUTATION_MIN;
  return Math.min(REPUTATION_MAX, Math.max(REPUTATION_MIN, value));
}

/** Apply a raw delta to a score, clamping to 0..100 and reporting the effective change. */
export function applyReputationDelta(current: number, rawDelta: number): ReputationUpdate {
  const from = clampReputation(current);
  const next = clampReputation(from + rawDelta);
  return { next, delta: next - from };
}

/** Apply the fixed delta for an event kind. */
export function applyReputation(current: number, kind: ReputationEventKind): ReputationUpdate {
  return applyReputationDelta(current, REPUTATION_DELTAS[kind]);
}
