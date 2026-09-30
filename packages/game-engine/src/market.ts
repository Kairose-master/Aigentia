import { stepMarketPrice, type MarketModelOptions } from "@aigentia/economy";
import type { ResourceType, SeededRandom } from "@aigentia/shared";
import type { MarketPriceRecord, WorldStore } from "./store/types";
import { MARKET_HISTORY_CAP, RESOURCE_BASE_PRICE_DROPS, RESOURCE_MAX_QUANTITY } from "./world";

export interface MarketStepResult {
  /** Deposits that regenerated this tick. */
  readonly regenerated: number;
  readonly prices: MarketPriceRecord[];
  readonly netDemand: Record<string, number>;
}

/** Units bought from the market minus units sold to it, per resource, for one tick. */
export async function netMarketDemand(
  store: WorldStore,
  tick: number,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const trade of await store.listTrades({ tick, counterparty: "market" })) {
    const sign = trade.buyerAgentId !== null ? 1 : -1;
    out[trade.resourceType] = (out[trade.resourceType] ?? 0) + sign * trade.quantity;
  }
  return out;
}

/**
 * End-of-tick world step: resource deposits regenerate (capped), then every market quote
 * takes one step of the economy pricing model driven by this tick's net demand, and the
 * quote is appended to a bounded history. Deterministic given the seeded rng.
 */
export async function stepMarket(
  store: WorldStore,
  tick: number,
  rng: SeededRandom,
  options: Partial<MarketModelOptions> = {},
): Promise<MarketStepResult> {
  let regenerated = 0;
  const resources = [...(await store.listResources())].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const r of resources) {
    if (r.regenPerTick <= 0 || r.quantity >= RESOURCE_MAX_QUANTITY) continue;
    await store.updateResource(r.id, {
      quantity: Math.min(RESOURCE_MAX_QUANTITY, r.quantity + r.regenPerTick),
    });
    regenerated += 1;
  }

  const netDemand = await netMarketDemand(store, tick);
  const prices = [...(await store.getMarketPrices())].sort((a, b) =>
    a.resourceType < b.resourceType ? -1 : a.resourceType > b.resourceType ? 1 : 0,
  );
  const updated: MarketPriceRecord[] = [];
  for (const p of prices) {
    const quote = stepMarketPrice({
      bidDrops: p.bidDrops,
      askDrops: p.askDrops,
      supply: p.supply,
      base: RESOURCE_BASE_PRICE_DROPS[p.resourceType as ResourceType],
      netDemand: netDemand[p.resourceType] ?? 0,
      rng,
      options,
    });
    const history = [
      ...p.history,
      { tick, bidDrops: quote.bidDrops.toString(), askDrops: quote.askDrops.toString() },
    ].slice(-MARKET_HISTORY_CAP);
    updated.push(
      await store.setMarketPrice({
        resourceType: p.resourceType,
        bidDrops: quote.bidDrops,
        askDrops: quote.askDrops,
        supply: p.supply,
        lastTick: tick,
        history,
      }),
    );
  }
  return { regenerated, prices: updated, netDemand };
}
