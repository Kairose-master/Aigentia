import { buildTestWorld, type TestWorld } from "@aigentia/game-engine/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryEventBus, bridgeEventLog } from "@aigentia/game-engine";
import { InMemoryLock, TICK_LOCK_KEY } from "./lock";
import { formatTickSummary, runOneTick, summarizeTick, type TickRunnerDeps } from "./tick-runner";

describe("runOneTick", () => {
  let world: TestWorld;
  let bus: InMemoryEventBus;
  let lock: InMemoryLock;
  let deps: TickRunnerDeps;

  beforeEach(async () => {
    world = await buildTestWorld({
      seed: "worker-tick",
      agents: [
        { name: "ORION-7", objective: "maximize_net_worth", capitalXrp: 10 },
        {
          name: "ATLAS-3",
          objective: "profitable_service",
          capitalXrp: 10,
          services: [{ kind: "SCOUT", priceDrops: "1000" }],
        },
      ],
    });
    bus = new InMemoryEventBus();
    lock = new InMemoryLock();
    bridgeEventLog(world.runtime.events, bus);
    deps = { store: world.store, runtime: world.runtime, lock };
  });

  it("skips when the simulation is not running and publishes nothing", async () => {
    expect((await world.store.getSimulationState()).running).toBe(false);
    const outcome = await runOneTick(deps);
    expect(outcome).toEqual({ skipped: true, reason: "not_running" });
    expect(bus.published).toHaveLength(0);
    expect((await world.store.getSimulationState()).currentTick).toBe(0);
    expect(lock.isHeld(TICK_LOCK_KEY)).toBe(false);
  });

  it("runs a tick under the lock and fans the tick's events out to the bus", async () => {
    await world.store.setSimulationState({ running: true });
    const outcome = await runOneTick(deps);
    expect(outcome.skipped).toBe(false);
    if (outcome.skipped) return;
    expect(outcome.result.tick).toBe(1);
    expect(outcome.result.agentsProcessed).toBe(2);
    expect(outcome.summary.tick).toBe(1);
    expect(outcome.summary.agents).toBe(2);
    expect(bus.published).toEqual(outcome.result.events);
    const types = bus.published.map((e) => e.type);
    expect(types[0]).toBe("TICK_STARTED");
    expect(types.at(-1)).toBe("TICK_FINISHED");
    expect(types).toContain("DECISION_MADE");
    expect((await world.store.getSimulationState()).currentTick).toBe(1);
    expect(lock.isHeld(TICK_LOCK_KEY)).toBe(false);

    const again = await runOneTick(deps);
    expect(again.skipped).toBe(false);
    if (!again.skipped) expect(again.result.tick).toBe(2);
  });

  it("skips when another tick holds the lock", async () => {
    await world.store.setSimulationState({ running: true });
    const held = await lock.acquire(TICK_LOCK_KEY, 60_000);
    expect(held).not.toBeNull();
    const outcome = await runOneTick(deps);
    expect(outcome).toEqual({ skipped: true, reason: "locked" });
    expect(bus.published).toHaveLength(0);
    expect((await world.store.getSimulationState()).currentTick).toBe(0);
    expect(await held?.release()).toBe(true);
    const after = await runOneTick(deps);
    expect(after.skipped).toBe(false);
  });

  it("releases the lock when the simulation throws", async () => {
    await world.store.setSimulationState({ running: true });
    const broken: TickRunnerDeps = {
      ...deps,
      runtime: {
        sim: {
          runTick: async () => {
            throw new Error("boom");
          },
        },
      },
    };
    await expect(runOneTick(broken)).rejects.toThrow("boom");
    expect(lock.isHeld(TICK_LOCK_KEY)).toBe(false);
    expect(bus.published).toHaveLength(0);
  });
});

describe("summarizeTick", () => {
  it("counts decisions by action type, outcomes and payment events", async () => {
    const world = await buildTestWorld({
      seed: "worker-summary",
      agents: [
        { name: "ORION-7", objective: "maximize_net_worth", capitalXrp: 10 },
        {
          name: "ATLAS-3",
          objective: "profitable_service",
          capitalXrp: 10,
          services: [{ kind: "SCOUT", priceDrops: "1000" }],
        },
      ],
    });
    const [result] = await world.runTicks(1);
    if (!result) throw new Error("no tick result");
    const summary = summarizeTick(result);
    expect(summary.tick).toBe(1);
    expect(summary.agents).toBe(2);
    const decisionCount = Object.values(summary.decisions).reduce((a, b) => a + (b ?? 0), 0);
    expect(decisionCount).toBe(result.decisions.length);
    const outcomeCount =
      summary.outcomes.success +
      summary.outcomes.failed +
      summary.outcomes.rejected +
      summary.outcomes.invalid;
    expect(outcomeCount).toBe(result.decisions.length);
    expect(summary.payments.validated).toBe(
      result.events.filter((e) => e.type === "PAYMENT_VALIDATED").length,
    );
    expect(summary.events).toBe(result.events.length);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    const line = formatTickSummary(summary);
    expect(line).toContain("tick 1");
    expect(line).toContain("2 agents");
    expect(line).toMatch(/payments validated=\d+ denied=\d+ failed=\d+/);
  });
});
