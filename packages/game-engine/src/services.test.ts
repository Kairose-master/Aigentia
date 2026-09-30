import { describe, expect, it } from "vitest";
import { isAigentiaError } from "@aigentia/shared";
import { scoutOutputSchema, analystOutputSchema, courierOutputSchema } from "@aigentia/protocol";
import { executeService, serviceInputError } from "./services";
import { InMemoryWorldStore } from "./store/in-memory";
import { genesisWorld } from "./world";

const seller = "agt_seller000001";
const buyer = "agt_buyer0000001";

async function world(): Promise<InMemoryWorldStore> {
  const store = new InMemoryWorldStore({
    seed: "svc",
    clock: () => new Date("2026-01-01T00:00:00Z"),
  });
  await store.seedWorld(genesisWorld("svc"));
  for (const [id, name] of [
    [seller, "SELLER"],
    [buyer, "BUYER"],
  ] as const) {
    await store.insertAgent({
      id,
      name,
      objective: "survive",
      brain: "deterministic",
      walletAddress: `r${name}0000000000000000000000000`,
      walletRef: id,
      budgetPolicy: {
        maxSpendPerActionDrops: "500000",
        maxSpendPerHourDrops: "3000000",
        maxDailySpendDrops: "8000000",
        allowedAssets: ["XRP"],
        allowedServiceCategories: ["intelligence", "analysis", "logistics"],
        minimumBalanceDrops: "1500000",
      },
      locationId: "loc_core",
    });
  }
  return store;
}

let counter = 0;
const ctx = (store: InMemoryWorldStore, tick = 3) => ({
  store,
  tick,
  sellerAgentId: seller,
  buyerAgentId: buyer,
  nextInventoryId: () => `itm_svc${(counter += 1).toString().padStart(6, "0")}`,
});

describe("services", () => {
  it("SCOUT reports deposits and stores them as the buyer's knowledge", async () => {
    const store = await world();
    const out = scoutOutputSchema.parse(
      await executeService("SCOUT", { resourceType: "ore" }, ctx(store)),
    );
    const deposits = (await store.listResources()).filter((r) => r.resourceType === "ore");
    expect(out.sightings.length).toBe(deposits.length);
    expect(
      out.sightings.every((s) => s.resourceType === "ore" && s.basePriceDrops === "2000"),
    ).toBe(true);
    const knowledge = await store.getKnowledge(buyer);
    expect(knowledge.length).toBe(deposits.length);
    expect(knowledge.every((k) => k.learnedAtTick === 3)).toBe(true);
  });

  it("ANALYST returns a schema-valid report per resource", async () => {
    const store = await world();
    const out = analystOutputSchema.parse(
      await executeService("ANALYST", { horizonTicks: 5 }, ctx(store)),
    );
    expect(out.reports.map((r) => r.resourceType)).toEqual(["alloy", "data", "energy", "ore"]);
    expect(
      out.reports.every((r) => r.trend === "flat" && r.cheapestListingUnitPriceDrops === null),
    ).toBe(true);
    const one = analystOutputSchema.parse(
      await executeService("ANALYST", { resourceType: "ore", horizonTicks: 5 }, ctx(store)),
    );
    expect(one.reports.length).toBe(1);
  });

  it("COURIER moves the buyer's inventory and fails when it is insufficient", async () => {
    const store = await world();
    await store.adjustInventory(buyer, "ore", "loc_core", 4, "itm_seed1");
    const input = {
      resourceType: "ore",
      quantity: 3,
      fromLocationId: "loc_core",
      toLocationId: "loc_east_relay",
    };
    const out = courierOutputSchema.parse(await executeService("COURIER", input, ctx(store)));
    expect(out.distance).toBe(4);
    const inventory = await store.getInventory(buyer);
    expect(inventory.find((i) => i.locationId === "loc_core")?.quantity).toBe(1);
    expect(inventory.find((i) => i.locationId === "loc_east_relay")?.quantity).toBe(3);
    await expect(
      executeService("COURIER", { ...input, quantity: 2 }, ctx(store)),
    ).rejects.toSatisfy((e: unknown) => isAigentiaError(e) && e.code === "INSUFFICIENT_FUNDS");
  });

  it("rejects malformed inputs before execution", () => {
    expect(serviceInputError("COURIER", { resourceType: "ore" })).not.toBeNull();
    expect(serviceInputError("SCOUT", {})).toBeNull();
  });
});
