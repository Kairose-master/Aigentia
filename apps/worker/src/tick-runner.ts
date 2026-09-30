import type { Simulation, TickResult, WorldStore } from "@aigentia/game-engine";
import type { ActionType } from "@aigentia/shared";
import { errorMessage, type Logger } from "@aigentia/shared";
import { TICK_LOCK_KEY, type TickLock } from "./lock";

export interface TickRunnerDeps {
  readonly store: WorldStore;
  readonly runtime: { readonly sim: Pick<Simulation, "runTick"> };
  readonly lock: TickLock;
  readonly logger?: Logger;
  /** How long the tick lock is held at most (crash protection); default 5 minutes. */
  readonly tickLockTtlMs?: number;
  readonly tickLockKey?: string;
}

export const DEFAULT_TICK_LOCK_TTL_MS = 5 * 60 * 1000;

export interface TickSummary {
  readonly tick: number;
  readonly agents: number;
  /** Decisions counted by action type (only types that occurred). */
  readonly decisions: Partial<Record<ActionType, number>>;
  readonly outcomes: { success: number; failed: number; rejected: number; invalid: number };
  readonly payments: { validated: number; denied: number; failed: number };
  readonly events: number;
  readonly errors: number;
  readonly bankrupt: number;
  readonly durationMs: number;
}

export type TickRunOutcome =
  | { readonly skipped: true; readonly reason: "not_running" | "locked" }
  | { readonly skipped: false; readonly result: TickResult; readonly summary: TickSummary };

/** Pure: compact statistics of one tick, for logs and the demo. */
export function summarizeTick(result: TickResult): TickSummary {
  const decisions: Partial<Record<ActionType, number>> = {};
  const outcomes = { success: 0, failed: 0, rejected: 0, invalid: 0 };
  for (const d of result.decisions) {
    decisions[d.action.type] = (decisions[d.action.type] ?? 0) + 1;
    if (d.outcomeStatus in outcomes) {
      outcomes[d.outcomeStatus as keyof typeof outcomes] += 1;
    }
  }
  const payments = { validated: 0, denied: 0, failed: 0 };
  for (const e of result.events) {
    if (e.type === "PAYMENT_VALIDATED") payments.validated += 1;
    else if (e.type === "PAYMENT_DENIED") payments.denied += 1;
    else if (e.type === "PAYMENT_FAILED") payments.failed += 1;
  }
  return {
    tick: result.tick,
    agents: result.agentsProcessed,
    decisions,
    outcomes,
    payments,
    events: result.events.length,
    errors: result.errors.length,
    bankrupt: result.bankrupt.length,
    durationMs: Math.max(0, result.finishedAt.getTime() - result.startedAt.getTime()),
  };
}

/** One-line human rendering, e.g. `tick 3 · 2 agents · BUY_SERVICE×1 WAIT×1 · payments ok=1 denied=0 failed=0`. */
export function formatTickSummary(s: TickSummary): string {
  const byType = Object.entries(s.decisions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type}×${n}`)
    .join(" ");
  const parts = [
    `tick ${s.tick}`,
    `${s.agents} agents`,
    byType || "no decisions",
    `outcomes ok=${s.outcomes.success} failed=${s.outcomes.failed} rejected=${s.outcomes.rejected} invalid=${s.outcomes.invalid}`,
    `payments validated=${s.payments.validated} denied=${s.payments.denied} failed=${s.payments.failed}`,
    `${s.events} events`,
    `${s.durationMs}ms`,
  ];
  if (s.errors > 0) parts.push(`${s.errors} errors`);
  if (s.bankrupt > 0) parts.push(`${s.bankrupt} bankrupt`);
  return parts.join(" · ");
}

/**
 * Run exactly one tick when the simulation is running and no other tick is in flight:
 *   simulationState.running === false → { skipped: "not_running" }
 *   lock held elsewhere                → { skipped: "locked" }
 *   otherwise Simulation.runTick() and log a summary. Events reach the bus live through the
 *   runtime's eventSink (wired in the container), so nothing is re-published here.
 * Errors from the simulation propagate (BullMQ records the failed job) after the lock is released.
 */
export async function runOneTick(deps: TickRunnerDeps): Promise<TickRunOutcome> {
  const state = await deps.store.getSimulationState();
  if (!state.running) {
    deps.logger?.debug({ tick: state.currentTick }, "simulation paused; tick skipped");
    return { skipped: true, reason: "not_running" };
  }
  const handle = await deps.lock.acquire(
    deps.tickLockKey ?? TICK_LOCK_KEY,
    deps.tickLockTtlMs ?? DEFAULT_TICK_LOCK_TTL_MS,
  );
  if (!handle) {
    deps.logger?.warn({ tick: state.currentTick + 1 }, "another tick is in flight; skipped");
    return { skipped: true, reason: "locked" };
  }
  try {
    const result = await deps.runtime.sim.runTick();
    const summary = summarizeTick(result);
    deps.logger?.info({ ...summary }, formatTickSummary(summary));
    for (const err of result.errors) {
      deps.logger?.error(
        { tick: result.tick, agentId: err.agentId, error: err.error },
        "agent error",
      );
    }
    return { skipped: false, result, summary };
  } finally {
    const released = await handle.release().catch((e: unknown) => {
      deps.logger?.warn({ error: errorMessage(e) }, "tick lock release failed");
      return false;
    });
    if (!released) deps.logger?.warn("tick lock expired before release; consider a longer TTL");
  }
}
