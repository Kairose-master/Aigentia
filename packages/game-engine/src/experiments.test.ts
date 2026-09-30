import { describe, expect, it } from "vitest";
import {
  GENESIS_24H,
  createExperiment,
  finishDueExperiments,
  finishExperiment,
  gini,
  objectiveSchedule,
  startExperiment,
  topShare,
} from "./experiments";
import { experimentConfigSchema } from "@aigentia/protocol";
import { buildTestWorld } from "./testing";

describe("experiment analytics helpers", () => {
  it("computes concentration", () => {
    expect(gini([10n, 10n, 10n, 10n])).toBe(0);
    expect(gini([0n, 0n, 0n, 100n])).toBeCloseTo(0.75, 5);
    expect(topShare([1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 91n])).toBeCloseTo(0.91, 5);
    expect(topShare([])).toBe(0);
  });

  it("interleaves objectives and honours the distribution", () => {
    const schedule = objectiveSchedule(experimentConfigSchema.parse(GENESIS_24H));
    expect(schedule).toHaveLength(20);
    expect(schedule.slice(0, 4)).toEqual([
      "maximize_net_worth",
      "survive",
      "maximize_information",
      "maximize_reputation",
    ]);
    for (const o of [
      "maximize_net_worth",
      "survive",
      "maximize_information",
      "maximize_reputation",
    ]) {
      expect(schedule.filter((x) => x === o)).toHaveLength(5);
    }
  });
});

describe("experiment lifecycle on the [MOCK] ledger", () => {
  it("runs Genesis 24H (20 agents) and derives every result from recorded, verified state", async () => {
    const world = await buildTestWorld({ seed: "genesis-24h", agents: [] });
    const deps = {
      ...world.runtime,
      createAgent: (i: Parameters<typeof world.runtime.createAgent>[0]) =>
        world.runtime.createAgent(i),
    };
    const draft = await createExperiment(deps, GENESIS_24H);
    expect(draft.status).toBe("draft");
    const started = await startExperiment(deps, draft.id);
    expect(started.status).toBe("running");
    expect((await world.store.getSimulationState()).running).toBe(true);
    await expect(startExperiment(deps, draft.id)).rejects.toMatchObject({ code: "CONFLICT" });

    await world.runTicks(12);
    // Not due yet (24h): nothing finishes on its own.
    expect(await finishDueExperiments(deps)).toHaveLength(0);
    const finished = await finishExperiment(deps, draft.id);
    const r = finished.results;
    if (!r) throw new Error("no results");

    const agents = await world.store.listAgents({ experimentId: draft.id });
    expect(agents).toHaveLength(20);
    expect(r.ticks).toBe(12);
    expect(r.wealthLeaderboard).toHaveLength(20);
    expect(r.wealthLeaderboard[0]?.rank).toBe(1);
    expect(BigInt(r.wealthLeaderboard[0]?.valueDrops ?? "0")).toBeGreaterThanOrEqual(
      BigInt(r.wealthLeaderboard[19]?.valueDrops ?? "0"),
    );
    expect(r.networkGraph.nodes).toHaveLength(20);
    expect(r.survival.alive + r.survival.bankrupt).toBe(20);

    // Re-derive the money figures from the raw payment rows.
    const payments = await world.store.listPaymentsForAgents(agents.map((a) => a.id));
    const verified = payments.filter((p) => p.status === "validated" && p.txHash);
    const economic = verified.filter((p) => p.kind !== "funding");
    expect(r.verifiedPayments).toBe(verified.length);
    expect(r.failedPayments).toBe(payments.filter((p) => p.status === "failed").length);
    expect(BigInt(r.totalVolumeDrops)).toBe(economic.reduce((s, p) => s + p.amountDrops, 0n));
    expect(economic.length).toBeGreaterThan(0);
    const edgeVolume = r.networkGraph.edges.reduce((s, e) => s + BigInt(e.volumeDrops), 0n);
    expect(edgeVolume).toBeLessThanOrEqual(BigInt(r.totalVolumeDrops));
    for (const e of r.networkGraph.edges) {
      expect(agents.some((a) => a.id === e.from) && agents.some((a) => a.id === e.to)).toBe(true);
    }
    const revenue = r.revenueLeaderboard.reduce((s, row) => s + BigInt(row.valueDrops), 0n);
    expect(revenue).toBeLessThanOrEqual(BigInt(r.totalVolumeDrops));
    await expect(finishExperiment(deps, draft.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a distribution that does not add up and finishes experiments past their deadline", async () => {
    const world = await buildTestWorld({
      seed: "exp-deadline",
      agents: [{ name: "OUTSIDER-1", objective: "maximize_net_worth", capitalXrp: 10 }],
    });
    const deps = {
      ...world.runtime,
      createAgent: (i: Parameters<typeof world.runtime.createAgent>[0]) =>
        world.runtime.createAgent(i),
    };
    await expect(
      createExperiment(deps, {
        ...GENESIS_24H,
        agentCount: 3,
        objectiveDistribution: [{ objective: "survive", count: 2 }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // 2 XRP cannot cover a 1.5 XRP minimum balance plus the 1 XRP reserve: agents could only wait.
    await expect(
      createExperiment(
        deps,
        { ...GENESIS_24H, startingCapitalXrp: 2 },
        { defaultMinimumBalanceDrops: 1_500_000n },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/nothing to spend/),
    });
    const draft = await createExperiment(deps, {
      ...GENESIS_24H,
      name: "Blink",
      durationHours: 0.0001,
      agentCount: 2,
      startingCapitalXrp: 5,
      objectiveDistribution: [
        { objective: "maximize_information", count: 1 },
        { objective: "profitable_service", count: 1 },
      ],
    });
    await startExperiment(deps, draft.id);
    // Agents outside the experiment are paused so they cannot trade with its agents.
    expect((await world.store.getAgent(world.agent("OUTSIDER-1").id))?.status).toBe("paused");
    await world.runTicks(2);
    const later = { ...deps, clock: () => new Date(Date.now() + 3_600_000 * 48) };
    const done = await finishDueExperiments(later);
    expect(done.map((e) => e.id)).toEqual([draft.id]);
    expect(done[0]?.status).toBe("finished");
  });
});
