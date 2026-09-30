import type { ServiceKind } from "@aigentia/shared";

/** A marketplace service as the ranker sees it (derived from the `services` table). */
export interface RankableService {
  readonly id: string;
  readonly kind: ServiceKind;
  readonly sellerAgentId: string;
  readonly priceDrops: bigint;
  readonly successfulCalls: number;
  readonly failedCalls: number;
  /** Seller reputation, 0..100. */
  readonly reputation: number;
  readonly avgLatencyMs: number;
  /** Tick of the last invocation, or null when never called. */
  readonly lastCalledTick: number | null;
}

export interface RankComponents {
  readonly taskRelevance: number;
  /** Laplace-smoothed: (successes + 1) / (successes + failures + 2). */
  readonly successRate: number;
  readonly reputationNorm: number;
  readonly freshness: number;
  readonly normalizedPrice: number;
  readonly normalizedLatency: number;
}

export type RankedService = RankableService & {
  readonly score: number;
  readonly components: RankComponents;
};

export interface RankContext {
  readonly taskKind: ServiceKind;
  /** Candidates priced above this are dropped before scoring. */
  readonly maxPriceDrops?: bigint;
  readonly tick: number;
}

export interface ServiceRanker {
  rank(candidates: readonly RankableService[], ctx: RankContext): RankedService[];
}

export interface RankerWeights {
  /** Penalty weight on the price normalised to the dearest candidate. */
  readonly price: number;
  /** Penalty weight on latency normalised to the slowest candidate. */
  readonly latency: number;
  /** Ticks over which freshness decays (e-folding). */
  readonly freshnessHalfLifeTicks: number;
}

export const DEFAULT_RANKER_WEIGHTS: RankerWeights = {
  price: 0.25,
  latency: 0.1,
  freshnessHalfLifeTicks: 50,
};

export function successRate(successfulCalls: number, failedCalls: number): number {
  const s = Math.max(0, successfulCalls);
  const f = Math.max(0, failedCalls);
  return (s + 1) / (s + f + 2);
}

/** Never called → 0.7 (unknown but worth a try); otherwise 0.5 + 0.5·exp(−age/τ). */
export function freshness(
  lastCalledTick: number | null,
  tick: number,
  tauTicks: number = DEFAULT_RANKER_WEIGHTS.freshnessHalfLifeTicks,
): number {
  if (lastCalledTick === null) return 0.7;
  const age = Math.max(0, tick - lastCalledTick);
  return 0.5 + 0.5 * Math.exp(-age / tauTicks);
}

function bigintToNumber(v: bigint): number {
  return Number(v);
}

/**
 * Deterministic baseline ranker:
 *   score = relevance × successRate × reputationNorm × freshness − wPrice × normPrice − wLatency × normLatency
 * Ties break by id so the order never depends on input order or floating-point luck.
 */
export class BaselineServiceRanker implements ServiceRanker {
  readonly weights: RankerWeights;

  constructor(weights: Partial<RankerWeights> = {}) {
    this.weights = { ...DEFAULT_RANKER_WEIGHTS, ...weights };
  }

  rank(candidates: readonly RankableService[], ctx: RankContext): RankedService[] {
    const eligible = candidates.filter(
      (c) => ctx.maxPriceDrops === undefined || c.priceDrops <= ctx.maxPriceDrops,
    );
    if (eligible.length === 0) return [];
    const maxPrice = eligible.reduce((m, c) => (c.priceDrops > m ? c.priceDrops : m), 0n);
    const maxLatency = eligible.reduce((m, c) => Math.max(m, c.avgLatencyMs), 0);
    const maxPriceNum = bigintToNumber(maxPrice);

    const ranked = eligible.map((c): RankedService => {
      const components: RankComponents = {
        taskRelevance: c.kind === ctx.taskKind ? 1 : 0,
        successRate: successRate(c.successfulCalls, c.failedCalls),
        reputationNorm: Math.min(1, Math.max(0, c.reputation / 100)),
        freshness: freshness(c.lastCalledTick, ctx.tick, this.weights.freshnessHalfLifeTicks),
        normalizedPrice: maxPriceNum > 0 ? bigintToNumber(c.priceDrops) / maxPriceNum : 0,
        normalizedLatency: maxLatency > 0 ? Math.max(0, c.avgLatencyMs) / maxLatency : 0,
      };
      const score =
        components.taskRelevance *
          components.successRate *
          components.reputationNorm *
          components.freshness -
        this.weights.price * components.normalizedPrice -
        this.weights.latency * components.normalizedLatency;
      return { ...c, score, components };
    });

    return ranked.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
}
