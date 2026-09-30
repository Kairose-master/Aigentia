import { applyReputation, type ReputationEventKind } from "@aigentia/economy";
import type { IdGenerator } from "./ids";
import type { AgentRecord, WorldStore } from "./store/types";

export interface ReputationContext {
  readonly tick: number;
  readonly at: Date;
  readonly ids: IdGenerator;
  readonly scope: string;
  readonly refKind?: string;
  readonly refId?: string;
}

export interface ReputationResult {
  readonly agent: AgentRecord;
  readonly delta: number;
}

/**
 * Apply one of the fixed reputation deltas to an agent: reads the current score, clamps to
 * 0..100 through the economy package, records the reputation event and writes the new score.
 */
export async function applyAgentReputation(
  store: WorldStore,
  agentId: string,
  kind: ReputationEventKind,
  ctx: ReputationContext,
): Promise<ReputationResult | null> {
  const agent = await store.getAgent(agentId);
  if (!agent) return null;
  const update = applyReputation(agent.reputation, kind);
  const { agent: next } = await store.addReputationEvent({
    id: ctx.ids.next("reputation", ctx.scope),
    agentId,
    delta: update.delta,
    next: update.next,
    reason: kind,
    refKind: ctx.refKind ?? null,
    refId: ctx.refId ?? null,
    tick: ctx.tick,
    createdAt: ctx.at,
  });
  return { agent: next, delta: update.delta };
}
