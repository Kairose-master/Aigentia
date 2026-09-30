import { describe, expect, it } from "vitest";
import { isAigentiaError } from "@aigentia/shared";
import { InMemoryWorldStore } from "./store/in-memory";
import type { NewPaymentInput, WorldStore } from "./store/types";
import { genesisWorld } from "./world";

const AGENT = {
  id: "agt_store00000001",
  name: "STORE-1",
  objective: "survive" as const,
  brain: "deterministic" as const,
  walletAddress: "rStoreTestAddress000000000000001",
  walletRef: "agt_store00000001",
  budgetPolicy: {
    maxSpendPerActionDrops: "500000",
    maxSpendPerHourDrops: "3000000",
    maxDailySpendDrops: "8000000",
    allowedAssets: ["XRP" as const],
    allowedServiceCategories: ["intelligence" as const, "analysis" as const, "logistics" as const],
    minimumBalanceDrops: "1500000",
  },
  locationId: "loc_core",
};

const TX = "A".repeat(64);

function payment(id: string, extra: Partial<NewPaymentInput> = {}): NewPaymentInput {
  return {
    id,
    intentId: null,
    kind: "transfer",
    status: "validated",
    ledger: "mock",
    senderAgentId: AGENT.id,
    receiverAgentId: null,
    senderAddress: AGENT.walletAddress,
    receiverAddress: "rReceiver000000000000000000000001",
    asset: "XRP",
    amountDrops: 1000n,
    tick: 1,
    ...extra,
  };
}

async function fresh(): Promise<WorldStore & InMemoryWorldStore> {
  const store = new InMemoryWorldStore({
    seed: "store-test",
    clock: () => new Date("2026-01-01T00:00:00Z"),
  });
  await store.seedWorld(genesisWorld("store-test"));
  await store.insertAgent(AGENT);
  return store;
}

describe("InMemoryWorldStore", () => {
  it("refuses a second payment with the same txHash (CONFLICT) and the same invoiceId", async () => {
    const store = await fresh();
    await store.recordPayment(payment("pay_a", { txHash: TX, invoiceId: "inv_1" }));
    await expect(store.recordPayment(payment("pay_b", { txHash: TX }))).rejects.toSatisfy(
      (e: unknown) => isAigentiaError(e) && e.code === "CONFLICT",
    );
    await expect(store.recordPayment(payment("pay_c", { invoiceId: "inv_1" }))).rejects.toSatisfy(
      (e: unknown) => isAigentiaError(e) && e.code === "CONFLICT",
    );
    await store.recordPayment(payment("pay_d", { status: "submitted" }));
    await expect(store.updatePayment("pay_d", { txHash: TX })).rejects.toSatisfy(
      (e: unknown) => isAigentiaError(e) && e.code === "CONFLICT",
    );
  });

  it("sums only submitted/validated outgoing XRP since a date", async () => {
    const store = await fresh();
    await store.recordPayment(
      payment("pay_1", { amountDrops: 100n, createdAt: new Date("2026-01-01T00:00:00Z") }),
    );
    await store.recordPayment(
      payment("pay_2", {
        amountDrops: 50n,
        status: "submitted",
        createdAt: new Date("2026-01-01T01:00:00Z"),
      }),
    );
    await store.recordPayment(
      payment("pay_3", {
        amountDrops: 7n,
        status: "denied",
        createdAt: new Date("2026-01-01T01:00:00Z"),
      }),
    );
    await store.recordPayment(
      payment("pay_4", {
        amountDrops: 9n,
        status: "failed",
        createdAt: new Date("2026-01-01T01:00:00Z"),
      }),
    );
    expect(await store.sumSpentSince(AGENT.id, new Date("2025-12-31T00:00:00Z"))).toBe(150n);
    expect(await store.sumSpentSince(AGENT.id, new Date("2026-01-01T00:30:00Z"))).toBe(50n);
  });

  it("claims a job exactly once", async () => {
    const store = await fresh();
    await store.createJob({
      id: "job_1",
      posterAgentId: AGENT.id,
      title: "Deliver ore",
      description: "Bring ore to core",
      rewardDrops: 50_000n,
      requirement: null,
      createdAtTick: 1,
      expiresAtTick: 30,
    });
    expect(await store.claimJob("job_1", "agt_worker0000001", 2)).toBe(true);
    expect(await store.claimJob("job_1", "agt_worker0000002", 2)).toBe(false);
    const job = await store.getJob("job_1");
    expect(job?.claimedByAgentId).toBe("agt_worker0000001");
    expect((await store.expireJobs(30)).map((j) => j.id)).toEqual(["job_1"]);
  });

  it("never lets inventory go below zero and fills listings atomically", async () => {
    const store = await fresh();
    await store.adjustInventory(AGENT.id, "ore", "loc_core", 5, "itm_1");
    await expect(store.adjustInventory(AGENT.id, "ore", "loc_core", -6, "itm_2")).rejects.toSatisfy(
      (e: unknown) => isAigentiaError(e) && e.code === "INSUFFICIENT_FUNDS",
    );
    await expect(
      store.adjustInventory(AGENT.id, "data", "loc_core", -1, "itm_3"),
    ).rejects.toSatisfy((e: unknown) => isAigentiaError(e) && e.code === "INSUFFICIENT_FUNDS");
    await store.createListing({
      id: "lst_1",
      sellerAgentId: AGENT.id,
      resourceType: "ore",
      quantity: 5,
      unitPriceDrops: 2_000n,
      tick: 1,
    });
    expect(await store.fillListing("lst_1", 6)).toBeNull();
    expect((await store.fillListing("lst_1", 3))?.quantity).toBe(2);
    expect((await store.fillListing("lst_1", 2))?.status).toBe("filled");
    expect(await store.fillListing("lst_1", 1)).toBeNull();
  });

  it("keeps knowledge inside agents.strategy and merges by resource/location", async () => {
    const store = await fresh();
    await store.addKnowledge(AGENT.id, [
      { resourceType: "ore", locationId: "loc_north_belt", quantity: 10, learnedAtTick: 1 },
    ]);
    const merged = await store.addKnowledge(AGENT.id, [
      { resourceType: "ore", locationId: "loc_north_belt", quantity: 12, learnedAtTick: 3 },
      { resourceType: "data", locationId: "loc_west_archive", quantity: 4, learnedAtTick: 2 },
    ]);
    expect(merged).toEqual([
      { resourceType: "ore", locationId: "loc_north_belt", quantity: 12, learnedAtTick: 3 },
      { resourceType: "data", locationId: "loc_west_archive", quantity: 4, learnedAtTick: 2 },
    ]);
    const agent = await store.getAgent(AGENT.id);
    expect(Array.isArray(agent?.strategy["knowledge"])).toBe(true);
  });

  it("hashes state independently of timestamps", async () => {
    const a = new InMemoryWorldStore({ seed: "h", clock: () => new Date("2026-01-01T00:00:00Z") });
    const b = new InMemoryWorldStore({ seed: "h", clock: () => new Date("2030-06-06T06:06:06Z") });
    for (const s of [a, b]) {
      await s.seedWorld(genesisWorld("h"));
      await s.insertAgent(AGENT);
      await s.appendEvents([
        {
          tick: 0,
          type: "AGENT_CREATED",
          message: "x",
          createdAt: s === a ? "2026-01-01T00:00:00.000Z" : "2031-01-01T00:00:00.000Z",
        },
      ]);
    }
    expect(a.stateHash()).toBe(b.stateHash());
    await a.updateAgent(AGENT.id, { reputation: 51 });
    expect(a.stateHash()).not.toBe(b.stateHash());
  });
});
