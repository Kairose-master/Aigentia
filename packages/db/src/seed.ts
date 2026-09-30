import { sql } from "drizzle-orm";
import {
  GENESIS_LOCATIONS,
  RESOURCE_TYPES,
  SeededRandom,
  deterministicId,
  type ResourceType,
} from "@aigentia/shared";
import type { Database } from "./client";
import { locations, marketPrices, resources, simulationState } from "./schema";

export interface SeedOptions {
  seed: string;
  ledger: "testnet" | "mock";
  tickSeconds: number;
}

/** Base prices (drops) for each resource in the Genesis Sector. 1 XRP = 1,000,000 drops. */
export const RESOURCE_BASE_PRICE_DROPS: Record<ResourceType, bigint> = {
  ore: 2_000n,
  data: 5_000n,
  energy: 3_000n,
  alloy: 12_000n,
};

/**
 * Idempotently seed the static world: locations, resource deposits, market quotes and the
 * simulation control row. Agents are created by the API/experiments, not here.
 */
export async function seedWorld(db: Database, opts: SeedOptions) {
  const rng = new SeededRandom(`${opts.seed}:world`);
  await db
    .insert(locations)
    .values(GENESIS_LOCATIONS.map((l) => ({ id: l.id, name: l.name, x: l.x, y: l.y })))
    .onConflictDoNothing();

  const deposits: (typeof resources.$inferInsert)[] = [];
  for (const loc of GENESIS_LOCATIONS) {
    for (const type of RESOURCE_TYPES) {
      if (loc.id === "loc_core") continue;
      if (!rng.chance(0.6)) continue;
      deposits.push({
        id: deterministicId("resource", `${opts.seed}:${loc.id}:${type}`),
        resourceType: type,
        locationId: loc.id,
        quantity: rng.int(20, 120),
        basePriceDrops: RESOURCE_BASE_PRICE_DROPS[type],
        regenPerTick: rng.int(0, 2),
      });
    }
  }
  if (deposits.length > 0) await db.insert(resources).values(deposits).onConflictDoNothing();

  await db
    .insert(marketPrices)
    .values(
      RESOURCE_TYPES.map((type) => {
        const base = RESOURCE_BASE_PRICE_DROPS[type];
        return {
          resourceType: type,
          bidDrops: (base * 90n) / 100n,
          askDrops: (base * 110n) / 100n,
          supply: 100,
          lastTick: 0,
          history: [],
        };
      }),
    )
    .onConflictDoNothing();

  await db
    .insert(simulationState)
    .values({
      id: 1,
      running: false,
      currentTick: 0,
      seed: opts.seed,
      ledger: opts.ledger,
      tickSeconds: opts.tickSeconds,
    })
    .onConflictDoUpdate({
      target: simulationState.id,
      set: { ledger: opts.ledger, tickSeconds: opts.tickSeconds, updatedAt: sql`now()` },
    });

  return {
    locations: GENESIS_LOCATIONS.length,
    resourceDeposits: deposits.length,
    marketPrices: RESOURCE_TYPES.length,
  };
}
