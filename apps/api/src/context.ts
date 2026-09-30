import { BaselineServiceRanker, type RankableService, type ServiceRanker } from "@aigentia/economy";
import type { AgentRecord, ServiceRecord, WorldStore } from "@aigentia/game-engine";
import type { SseEnvelope } from "@aigentia/protocol";
import {
  AigentiaError,
  SERVICE_KINDS,
  type Env,
  type Logger,
  type ServiceKind,
} from "@aigentia/shared";
import type { ApiRuntime, SseOptions } from "./deps";
import { agentNames, avgLatencyMs, netWorthOf, statsDto, type DtoContext } from "./dto";
import type { EventBus } from "@aigentia/game-engine";
import type { ReadModel } from "./read-model";
import type { AgentSummaryDto, StatsDto } from "@aigentia/protocol";
import { agentSummaryDto } from "./dto";

export const DEFAULT_SSE: Required<SseOptions> = {
  statsIntervalMs: 5_000,
  heartbeatIntervalMs: 15_000,
  retryMs: 3_000,
};

/** Resolved dependencies plus the helpers every route shares. */
export interface RouteContext {
  readonly env: Env;
  readonly store: WorldStore;
  readonly events: EventBus;
  readonly runtime: ApiRuntime;
  readonly readModel: ReadModel;
  readonly logger: Logger | undefined;
  readonly clock: () => Date;
  readonly ranker: ServiceRanker;
  readonly sse: Required<SseOptions>;
  readonly startedAt: Date;
  /** Human-readable network label for stats: XRPL_NETWORK on testnet, "mock" otherwise. */
  readonly network: string;
  /** Serialises admin ticks: at most one runs at a time. */
  tickInProgress: boolean;
}

export function dtoContext(ctx: RouteContext, agents: readonly AgentRecord[]): DtoContext {
  return {
    ledger: ctx.runtime.ledger,
    explorerBase: ctx.env.XRPL_EXPLORER_URL,
    treasuryAddress: ctx.runtime.treasury.address,
    names: agentNames(agents),
  };
}

export async function summariseAgents(
  ctx: RouteContext,
  agents: readonly AgentRecord[],
): Promise<AgentSummaryDto[]> {
  const prices = await ctx.store.getMarketPrices();
  const out: AgentSummaryDto[] = [];
  for (const agent of agents) {
    const inventory = await ctx.store.getInventory(agent.id);
    out.push(
      agentSummaryDto(agent, netWorthOf(agent, inventory, prices), {
        ledger: ctx.runtime.ledger,
        explorerBase: ctx.env.XRPL_EXPLORER_URL,
      }),
    );
  }
  return out;
}

export async function computeStats(ctx: RouteContext): Promise<StatsDto> {
  const [agents, state, totals, activeJobs] = await Promise.all([
    ctx.store.listAgents(),
    ctx.store.getSimulationState(),
    ctx.readModel.paymentTotals(),
    ctx.readModel.countActiveJobs(),
  ]);
  return statsDto({
    agents: agents.length,
    activeAgents: agents.filter((a) => a.status === "active").length,
    totals,
    activeJobs,
    tick: state.currentTick,
    ledger: ctx.runtime.ledger,
    network: ctx.network,
    now: ctx.clock(),
  });
}

export function statsEnvelope(stats: StatsDto): SseEnvelope {
  return {
    channel: "stats",
    data: {
      agents: stats.agents,
      transactions: stats.transactions,
      servicePurchases: stats.servicePurchases,
      activeJobs: stats.activeJobs,
      volumeDrops: stats.volumeDrops,
      tick: stats.tick,
    },
  };
}

export function isServiceKind(value: string): value is ServiceKind {
  return (SERVICE_KINDS as readonly string[]).includes(value);
}

function rankable(s: ServiceRecord, reputation: number, tick: number): RankableService {
  return {
    id: s.id,
    kind: s.kind,
    sellerAgentId: s.sellerAgentId,
    priceDrops: s.priceDrops,
    successfulCalls: s.successfulCalls,
    failedCalls: s.failedCalls,
    reputation,
    avgLatencyMs: avgLatencyMs(s),
    lastCalledTick: s.lastCalledAt === null ? null : tick,
  };
}

export interface RankedListing {
  readonly service: ServiceRecord;
  readonly score: number;
}

/**
 * Rank services with the deterministic BaselineServiceRanker: each kind is ranked against
 * itself (relevance 1) and the lists are merged by score desc, id asc.
 */
export function rankMarket(
  services: readonly ServiceRecord[],
  agentsById: ReadonlyMap<string, AgentRecord>,
  ranker: ServiceRanker,
  tick: number,
  kind?: ServiceKind,
): RankedListing[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const out: RankedListing[] = [];
  for (const k of kind ? [kind] : SERVICE_KINDS) {
    const candidates = services
      .filter((s) => s.kind === k)
      .map((s) => rankable(s, agentsById.get(s.sellerAgentId)?.reputation ?? 50, tick));
    for (const r of ranker.rank(candidates, { taskKind: k, tick })) {
      const service = byId.get(r.id);
      if (service) out.push({ service, score: r.score });
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.service.id < b.service.id ? -1 : 1));
}

export function defaultRanker(): ServiceRanker {
  return new BaselineServiceRanker();
}

export function notFound(kind: string, id: string): AigentiaError {
  return new AigentiaError("NOT_FOUND", `${kind} ${id} not found`, { kind, id });
}
