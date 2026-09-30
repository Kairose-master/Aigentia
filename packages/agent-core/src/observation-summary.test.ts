import { describe, expect, it } from "vitest";
import { observationSchema } from "@aigentia/protocol";
import { VIEW_LIMITS, compactObservation, summarizeObservation } from "./observation-summary";
import { parseMemory, updateMemory } from "./memory";
import { syntheticObservation } from "./testing/fixtures";

describe("summarizeObservation", () => {
  it("renders a single line with balance, services, jobs and agents", () => {
    const obs = syntheticObservation({ balanceDrops: 9_420_000n, services: 3, jobs: 1, agents: 2 });
    const line = summarizeObservation(obs);
    expect(line).toBe("Balance 9.42 XRP · 3 services · 1 open job · 2 nearby agents");
    expect(line).not.toContain("\n");
  });
});

describe("compactObservation", () => {
  it("bounds every list and keeps the best entries", () => {
    const obs = syntheticObservation({
      services: 20,
      jobs: 15,
      agents: 12,
      events: 30,
      listings: 12,
      knowledge: 14,
    });
    const view = compactObservation(obs);
    expect(view.availableServices).toHaveLength(VIEW_LIMITS.availableServices);
    expect(view.availableJobs).toHaveLength(VIEW_LIMITS.availableJobs);
    expect(view.recentEvents).toHaveLength(VIEW_LIMITS.recentEvents);
    expect(view.nearbyAgents).toHaveLength(VIEW_LIMITS.nearbyAgents);
    expect(view.resourceListings).toHaveLength(VIEW_LIMITS.resourceListings);
    expect(view.knowledge).toHaveLength(VIEW_LIMITS.knowledge);
    const scores = view.availableServices.map((s) => s.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const bestScore = Math.max(...obs.availableServices.map((s) => s.score));
    expect(scores[0]).toBe(bestScore);
    const rewards = view.availableJobs.map((j) => BigInt(j.rewardDrops));
    for (let i = 1; i < rewards.length; i++) expect(rewards[i - 1]! >= rewards[i]!).toBe(true);
    expect(view.recentEvents).toEqual(obs.recentEvents.slice(-VIEW_LIMITS.recentEvents));
    expect(view.truncated.availableServices).toBe(20 - VIEW_LIMITS.availableServices);
    expect(view.summary).toBe(summarizeObservation(obs));
    const { summary: _s, truncated: _t, ...rest } = view;
    expect(observationSchema.safeParse(rest).success).toBe(true);
  });

  it("is deterministic and does not mutate the input", () => {
    const obs = syntheticObservation({ services: 9 });
    const snapshot = JSON.stringify(obs);
    const a = compactObservation(obs);
    const b = compactObservation(obs);
    expect(a).toEqual(b);
    expect(JSON.stringify(obs)).toBe(snapshot);
  });
});

describe("memory", () => {
  it("parses garbage leniently", () => {
    expect(parseMemory(null).consecutiveFailures).toBe(0);
    expect(
      parseMemory({ consecutiveFailures: "nope", priceDrops: { SCOUT: "abc" } }).priceDrops,
    ).toEqual({});
    expect(parseMemory([1, 2]).lessons).toEqual([]);
  });

  it("adjusts service prices from demand", () => {
    const base = syntheticObservation({ objective: "profitable_service" });
    const svc = {
      id: "svc_analyst0001",
      kind: "ANALYST" as const,
      priceDrops: "100000",
      totalCalls: 0,
      revenueDrops: "0",
    };
    const wait = { action: { type: "WAIT" as const }, summary: "Holding position.", reason: "r" };
    let memory = updateMemory({ ...base, myServices: [svc] }, wait, {
      status: "success",
      outcome: "ok",
    });
    expect(memory.priceDrops.ANALYST).toBeUndefined();
    memory = updateMemory({ ...base, myServices: [{ ...svc, totalCalls: 2 }], memory }, wait, {
      status: "success",
      outcome: "ok",
    });
    expect(memory.priceDrops.ANALYST).toBe("110000");
    for (let i = 0; i < 5; i++) {
      memory = updateMemory({ ...base, myServices: [{ ...svc, totalCalls: 2 }], memory }, wait, {
        status: "success",
        outcome: "ok",
      });
    }
    expect(memory.priceDrops.ANALYST).toBe("99000");
  });
});
