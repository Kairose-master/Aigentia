import { buildTestWorld } from "@aigentia/game-engine/testing";
import { describe, expect, it } from "vitest";
import { parseDemoArgs } from "./args";
import { DEMO_AGENTS, ensureDemoAgents, missingDemoAgents } from "./demo-agents";

describe("missingDemoAgents (pure)", () => {
  it("returns every spec for an empty world", () => {
    expect(missingDemoAgents([]).map((s) => s.name)).toEqual(["ORION-7", "ATLAS-3"]);
  });

  it("is idempotent: nothing is missing once both exist, regardless of case", () => {
    expect(missingDemoAgents([{ name: "ORION-7" }, { name: "atlas-3" }])).toEqual([]);
    expect(missingDemoAgents([{ name: "ORION-7" }]).map((s) => s.name)).toEqual(["ATLAS-3"]);
  });

  it("ignores unrelated agents", () => {
    expect(missingDemoAgents([{ name: "VEGA-1" }])).toHaveLength(DEMO_AGENTS.length);
  });

  it("the demo cast matches the acceptance test", () => {
    const [orion, atlas] = DEMO_AGENTS;
    expect(orion?.objective).toBe("maximize_net_worth");
    expect(orion?.startingCapitalXrp).toBe(10);
    expect(atlas?.objective).toBe("profitable_service");
    expect(atlas?.services).toEqual([{ kind: "SCOUT", priceDrops: "1000" }]);
  });
});

describe("ensureDemoAgents", () => {
  it("creates the cast once and finds it on the second run", async () => {
    const world = await buildTestWorld({ seed: "worker-demo", agents: [] });
    const first = await ensureDemoAgents(world.runtime, world.store);
    expect(first.created).toEqual(["ORION-7", "ATLAS-3"]);
    expect(first.agents.map((a) => a.name)).toEqual(["ORION-7", "ATLAS-3"]);
    const atlas = first.agents[1];
    expect(atlas).toBeDefined();
    const services = await world.store.listServices({ sellerAgentId: atlas?.id ?? "" });
    expect(services.map((s) => [s.kind, s.priceDrops])).toEqual([["SCOUT", 1000n]]);
    const balance = await world.ledger.getBalanceDrops(first.agents[0]?.walletAddress ?? "");
    expect(balance.balanceDrops).toBe(10_000_000n);

    const second = await ensureDemoAgents(world.runtime, world.store);
    expect(second.created).toEqual([]);
    expect(second.agents.map((a) => a.id)).toEqual(first.agents.map((a) => a.id));
    expect(await world.store.listAgents()).toHaveLength(2);
  });
});

describe("parseDemoArgs", () => {
  it("defaults to 5 ticks and accepts both flag spellings", () => {
    expect(parseDemoArgs([])).toEqual({ ticks: 5 });
    expect(parseDemoArgs(["--ticks", "3"])).toEqual({ ticks: 3 });
    expect(parseDemoArgs(["--ticks=12"])).toEqual({ ticks: 12 });
    expect(parseDemoArgs(["--verbose"])).toEqual({ ticks: 5 });
  });

  it("rejects non-integers", () => {
    expect(() => parseDemoArgs(["--ticks", "x"])).toThrow(/--ticks/);
    expect(() => parseDemoArgs(["--ticks"])).toThrow(/--ticks/);
    expect(() => parseDemoArgs(["--ticks=-1"])).toThrow(/--ticks/);
  });
});
