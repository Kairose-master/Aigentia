import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "@aigentia/db";
import { envSchema, isAigentiaError } from "@aigentia/shared";
import { sql } from "drizzle-orm";
import { createRuntime, type Runtime } from "./runtime";
import { PostgresWorldStore } from "./store/postgres";
import { steppedClock } from "./testing";
import { genesisWorld } from "./world";

/**
 * Postgres-backed engine test. Runs only when DATABASE_URL is set (migrations applied);
 * it truncates the tables it writes to and never touches the schema or the static world.
 */
const DATABASE_URL = process.env["DATABASE_URL"];
const describePg = DATABASE_URL ? describe : describe.skip;

const WRITTEN_TABLES = [
  "ledger_transactions",
  "trades",
  "service_invocations",
  "decisions",
  "reputation_events",
  "agent_snapshots",
  "resource_listings",
  "inventory_items",
  "jobs",
  "bounties",
  "payments",
  "payment_intents",
  "services",
  "agents",
  "world_events",
  "ticks",
];

describePg("PostgresWorldStore", () => {
  let handle: DbHandle;
  let store: PostgresWorldStore;
  let runtime: Runtime;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL ?? "", { max: 4 });
    await handle.db.execute(
      sql.raw(`TRUNCATE ${WRITTEN_TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`),
    );
    store = new PostgresWorldStore(handle.db);
    const env = envSchema.parse({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SIM_LEDGER: "mock",
      SIM_SEED: "pg-test",
      DATABASE_URL,
    });
    runtime = await createRuntime(env, { ledger: "mock", store, clock: steppedClock() });
    await store.setSimulationState({ currentTick: 0, running: false });
    // The static world is shared between runs: put the quotes (which ticks rewrite) back to genesis.
    for (const quote of genesisWorld("pg-test").marketPrices) {
      await store.setMarketPrice({ ...quote, lastTick: 0, history: [] });
    }
    await runtime.connect();
  });

  afterAll(async () => {
    await runtime?.close();
    await handle?.close();
  });

  it("creates 2 agents and runs 3 ticks", async () => {
    const orion = await runtime.createAgent({
      name: "PG-ORION",
      objective: "maximize_net_worth",
      brain: "deterministic",
      startingCapitalXrp: 20,
      services: [{ kind: "ANALYST", priceDrops: "8000" }],
    });
    const atlas = await runtime.createAgent({
      name: "PG-ATLAS",
      objective: "survive",
      brain: "deterministic",
      startingCapitalXrp: 20,
      services: [{ kind: "SCOUT", priceDrops: "5000" }],
    });
    expect(orion.balanceDrops).toBe(20_000_000n);
    expect(atlas.walletRef).toBe(atlas.id);
    const funding = await store.listPaymentsForAgent(orion.id);
    expect(funding[0]?.status).toBe("validated");
    expect(funding[0]?.ledger).toBe("mock");

    const results = await runtime.sim.runTicks(3);
    expect(results.map((r) => r.tick)).toEqual([1, 2, 3]);
    expect(results.every((r) => r.agentsProcessed === 2 && r.errors.length === 0)).toBe(true);
    expect((await store.getSimulationState()).currentTick).toBe(3);
    const decisions = await store.listDecisions(orion.id);
    expect(decisions.length).toBe(3);
    expect(decisions.every((d) => d.outcomeStatus !== "pending")).toBe(true);
    const snapshots = await store.listSnapshots(orion.id);
    expect(snapshots.map((s) => s.tick)).toEqual([1, 2, 3]);
    const events = await store.recentEvents(500);
    expect(events.filter((e) => e.type === "TICK_FINISHED").length).toBe(3);
    const prices = await store.getMarketPrices();
    expect(prices.every((p) => p.lastTick === 3 && p.history.length === 3)).toBe(true);
  });

  it("enforces one tx hash per payment through the unique index", async () => {
    const orion = await store.getAgentByName("PG-ORION");
    expect(orion).not.toBeNull();
    const base = {
      intentId: null,
      kind: "transfer" as const,
      status: "validated" as const,
      ledger: "mock" as const,
      senderAgentId: orion?.id ?? null,
      receiverAgentId: null,
      senderAddress: orion?.walletAddress ?? "",
      receiverAddress: "rReceiver000000000000000000000001",
      asset: "XRP",
      amountDrops: 10n,
      tick: 3,
    };
    await store.recordPayment({ ...base, id: "pay_pgdup000001", txHash: "B".repeat(64) });
    await expect(
      store.recordPayment({ ...base, id: "pay_pgdup000002", txHash: "B".repeat(64) }),
    ).rejects.toSatisfy((e: unknown) => isAigentiaError(e) && e.code === "CONFLICT");
    await store.recordPayment({ ...base, id: "pay_pgdup000003", status: "submitted" });
    await expect(
      store.updatePayment("pay_pgdup000003", { txHash: "B".repeat(64) }),
    ).rejects.toSatisfy((e: unknown) => isAigentiaError(e) && e.code === "CONFLICT");
  });

  it("claims a job atomically and runs a transaction against the tx-bound store", async () => {
    const orion = await store.getAgentByName("PG-ORION");
    const job = await store.createJob({
      id: "job_pgclaim0001",
      posterAgentId: orion?.id ?? "",
      title: "PG job",
      description: "Claim me once.",
      rewardDrops: 1_000n,
      requirement: null,
      createdAtTick: 3,
      expiresAtTick: 30,
    });
    const atlas = await store.getAgentByName("PG-ATLAS");
    const [first, second] = await Promise.all([
      store.claimJob(job.id, atlas?.id ?? "", 4),
      store.claimJob(job.id, orion?.id ?? "", 4),
    ]);
    expect([first, second].filter(Boolean).length).toBe(1);
    await expect(
      store.transaction(async (tx) => {
        await tx.adjustInventory(atlas?.id ?? "", "ore", "loc_core", 3, "itm_pgtx000001");
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect((await store.getInventory(atlas?.id ?? "")).length).toBe(0);
  });
});
