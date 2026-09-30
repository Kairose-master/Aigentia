import {
  GENESIS_LOCATIONS,
  RESOURCE_TYPES,
  SeededRandom,
  deterministicId,
  dropsToXrp,
  type ResourceType,
} from "@aigentia/shared";
import { budgetPolicySchema, type BudgetPolicy } from "@aigentia/protocol";

/** Base prices (drops) per resource in the Genesis Sector. Mirrors packages/db seed.ts. */
export const RESOURCE_BASE_PRICE_DROPS: Record<ResourceType, bigint> = {
  ore: 2_000n,
  data: 5_000n,
  energy: 3_000n,
  alloy: 12_000n,
};

/** Resource deposits never grow past this many units through regeneration. */
export const RESOURCE_MAX_QUANTITY = 500;

/** Market price history kept per resource (entries). */
export const MARKET_HISTORY_CAP = 500;

/** Every agent starts here. */
export const GENESIS_LOCATION_ID = "loc_core";

/** Knowledge entries kept per agent (newest first). */
export const KNOWLEDGE_CAP = 40;

export interface GenesisLocation {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export interface GenesisResource {
  readonly id: string;
  readonly resourceType: ResourceType;
  readonly locationId: string;
  readonly quantity: number;
  readonly basePriceDrops: bigint;
  readonly regenPerTick: number;
}

export interface GenesisMarketPrice {
  readonly resourceType: ResourceType;
  readonly bidDrops: bigint;
  readonly askDrops: bigint;
  readonly supply: number;
}

export interface GenesisWorld {
  readonly seed: string;
  readonly locations: readonly GenesisLocation[];
  readonly resources: readonly GenesisResource[];
  readonly marketPrices: readonly GenesisMarketPrice[];
}

/**
 * The static Genesis Sector for a seed: the five locations, seeded resource deposits and
 * opening market quotes. Identical to the database seed so an in-memory world and a
 * Postgres world on the same seed start from the same state.
 */
export function genesisWorld(seed: string): GenesisWorld {
  const rng = new SeededRandom(`${seed}:world`);
  const resources: GenesisResource[] = [];
  for (const loc of GENESIS_LOCATIONS) {
    for (const type of RESOURCE_TYPES) {
      if (loc.id === GENESIS_LOCATION_ID) continue;
      if (!rng.chance(0.6)) continue;
      resources.push({
        id: deterministicId("resource", `${seed}:${loc.id}:${type}`),
        resourceType: type,
        locationId: loc.id,
        quantity: rng.int(20, 120),
        basePriceDrops: RESOURCE_BASE_PRICE_DROPS[type],
        regenPerTick: rng.int(0, 2),
      });
    }
  }
  const marketPrices = RESOURCE_TYPES.map((type): GenesisMarketPrice => {
    const base = RESOURCE_BASE_PRICE_DROPS[type];
    return {
      resourceType: type,
      bidDrops: (base * 90n) / 100n,
      askDrops: (base * 110n) / 100n,
      supply: 100,
    };
  });
  return {
    seed,
    locations: GENESIS_LOCATIONS.map((l) => ({ id: l.id, name: l.name, x: l.x, y: l.y })),
    resources,
    marketPrices,
  };
}

/** Euclidean distance between two locations. */
export function locationDistance(a: GenesisLocation, b: GenesisLocation): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Pseudo-agent id used on payment intents the treasury signs (funding, market buys). */
export const TREASURY_AGENT_ID = "agt_treasury";
export const TREASURY_NAME = "TREASURY";

/** The treasury is not an agent: its policy only guards against runaway market payouts. */
export const TREASURY_BUDGET_POLICY: BudgetPolicy = budgetPolicySchema.parse({
  maxSpendPerActionDrops: (1_000n * 1_000_000n).toString(),
  maxSpendPerHourDrops: (100_000n * 1_000_000n).toString(),
  maxDailySpendDrops: (1_000_000n * 1_000_000n).toString(),
  minimumBalanceDrops: "0",
  allowedAssets: ["XRP"],
});

/** "0.001 XRP" style amounts for spectator messages. */
export function fmtXrp(drops: bigint): string {
  return `${dropsToXrp(drops)} XRP`;
}
