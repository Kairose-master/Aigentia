import { analystInputSchema, analystOutputSchema, type AnalystOutput } from "@aigentia/protocol";
import type { MarketHistoryEntry, MarketPriceRecord } from "../store/types";
import { RESOURCE_BASE_PRICE_DROPS } from "../world";
import type { ServiceContext } from "./types";

type Trend = "rising" | "falling" | "flat";
type Recommendation = "buy" | "sell" | "hold";

/** Relative move below which the trend counts as flat. */
const FLAT_BAND = 0.01;
/** Ask below base × (1 − band) → buy; bid above base × (1 + band) → sell. */
const VALUE_BAND = 0.05;

function mid(entry: { bidDrops: string | bigint; askDrops: string | bigint }): number {
  return (Number(entry.bidDrops) + Number(entry.askDrops)) / 2;
}

export interface MarketAnalysis {
  readonly trend: Trend;
  readonly volatility: number;
  readonly recommendation: Recommendation;
}

/** Pure analysis of one resource's quote and history over `horizon` ticks. */
export function analyseMarket(
  price: Pick<MarketPriceRecord, "resourceType" | "bidDrops" | "askDrops">,
  history: readonly MarketHistoryEntry[],
  horizon: number,
): MarketAnalysis {
  const current = mid(price);
  const window = history.slice(-horizon);
  const oldest = window[0];
  const reference = oldest ? mid(oldest) : current;
  const move = reference > 0 ? (current - reference) / reference : 0;
  const trend: Trend = move > FLAT_BAND ? "rising" : move < -FLAT_BAND ? "falling" : "flat";

  const mids = [...window.map(mid), current];
  const returns: number[] = [];
  for (let i = 1; i < mids.length; i++) {
    const prev = mids[i - 1] ?? 0;
    const next = mids[i] ?? 0;
    if (prev > 0) returns.push((next - prev) / prev);
  }
  let volatility = 0;
  if (returns.length > 1) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    volatility = Math.sqrt(variance);
  }
  volatility = Math.round(volatility * 1e6) / 1e6;

  const base = Number(RESOURCE_BASE_PRICE_DROPS[price.resourceType]);
  const ask = Number(price.askDrops);
  const bid = Number(price.bidDrops);
  let recommendation: Recommendation = "hold";
  if (ask < base * (1 - VALUE_BAND) && trend !== "falling") recommendation = "buy";
  else if (bid > base * (1 + VALUE_BAND) && trend !== "rising") recommendation = "sell";
  return { trend, volatility, recommendation };
}

/**
 * ANALYST: per-resource quote, supply, trend over the requested horizon, volatility of the
 * price path, a buy/sell/hold recommendation and the cheapest open listing.
 */
export async function executeAnalyst(input: unknown, ctx: ServiceContext): Promise<AnalystOutput> {
  const params = analystInputSchema.parse(input);
  const [prices, listings] = await Promise.all([
    ctx.store.getMarketPrices(),
    ctx.store.listListings({ status: "open" }),
  ]);
  const reports = prices
    .filter((p) => params.resourceType === undefined || p.resourceType === params.resourceType)
    .sort((a, b) =>
      a.resourceType < b.resourceType ? -1 : a.resourceType > b.resourceType ? 1 : 0,
    )
    .map((p) => {
      const analysis = analyseMarket(p, p.history, params.horizonTicks);
      const cheapest = listings
        .filter((l) => l.resourceType === p.resourceType && l.quantity > 0)
        .reduce<bigint | null>(
          (min, l) => (min === null || l.unitPriceDrops < min ? l.unitPriceDrops : min),
          null,
        );
      return {
        resourceType: p.resourceType,
        bidDrops: p.bidDrops.toString(),
        askDrops: p.askDrops.toString(),
        supply: p.supply,
        trend: analysis.trend,
        volatility: analysis.volatility,
        recommendation: analysis.recommendation,
        cheapestListingUnitPriceDrops: cheapest === null ? null : cheapest.toString(),
      };
    });
  return analystOutputSchema.parse({ tick: ctx.tick, reports });
}
