import { describe, expect, it } from "vitest";
import { SeededRandom } from "@aigentia/shared";
import { BaselineServiceRanker, freshness, successRate, type RankableService } from "./ranker";

function svc(overrides: Partial<RankableService> & { id: string }): RankableService {
  return {
    kind: "SCOUT",
    sellerAgentId: `agt_${overrides.id}`,
    priceDrops: 100_000n,
    successfulCalls: 10,
    failedCalls: 0,
    reputation: 50,
    avgLatencyMs: 100,
    lastCalledTick: null,
    ...overrides,
  };
}

const ranker = new BaselineServiceRanker();

describe("BaselineServiceRanker", () => {
  it("prefers reliable, reputable, cheap and fast services", () => {
    const candidates = [
      svc({ id: "svc_flaky", successfulCalls: 2, failedCalls: 8 }),
      svc({ id: "svc_solid", successfulCalls: 20, failedCalls: 0, reputation: 90 }),
      svc({ id: "svc_pricey", priceDrops: 400_000n, reputation: 90, successfulCalls: 20 }),
      svc({ id: "svc_slow", avgLatencyMs: 5_000 }),
    ];
    const ranked = ranker.rank(candidates, { taskKind: "SCOUT", tick: 10 });
    expect(ranked.map((r) => r.id)).toEqual(["svc_solid", "svc_pricey", "svc_slow", "svc_flaky"]);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
    const solid = ranked[0]!;
    expect(solid.components).toMatchObject({
      taskRelevance: 1,
      successRate: 21 / 22,
      reputationNorm: 0.9,
      freshness: 0.7,
      normalizedPrice: 0.25,
      normalizedLatency: 0.02,
    });
    expect(solid.score).toBeCloseTo(1 * (21 / 22) * 0.9 * 0.7 - 0.25 * 0.25 - 0.1 * 0.02, 12);
  });

  it("filters out candidates above the price ceiling", () => {
    const candidates = [
      svc({ id: "svc_a", priceDrops: 50_000n }),
      svc({ id: "svc_b", priceDrops: 150_000n }),
      svc({ id: "svc_c", priceDrops: 150_001n }),
    ];
    const ranked = ranker.rank(candidates, {
      taskKind: "SCOUT",
      tick: 1,
      maxPriceDrops: 150_000n,
    });
    expect(ranked.map((r) => r.id)).toEqual(["svc_a", "svc_b"]);
    expect(ranked[1]?.components.normalizedPrice).toBe(1);
    expect(ranker.rank(candidates, { taskKind: "SCOUT", tick: 1, maxPriceDrops: 1n })).toEqual([]);
  });

  it("is deterministic regardless of input order and breaks ties by id", () => {
    const candidates = [
      svc({ id: "svc_c" }),
      svc({ id: "svc_a" }),
      svc({ id: "svc_b" }),
      svc({ id: "svc_d", reputation: 80 }),
    ];
    const rng = new SeededRandom("ranker");
    const baseline = ranker.rank(candidates, { taskKind: "SCOUT", tick: 5 }).map((r) => r.id);
    expect(baseline).toEqual(["svc_d", "svc_a", "svc_b", "svc_c"]);
    for (let i = 0; i < 10; i++) {
      const shuffled = rng.shuffle(candidates);
      expect(ranker.rank(shuffled, { taskKind: "SCOUT", tick: 5 }).map((r) => r.id)).toEqual(
        baseline,
      );
    }
  });

  it("scores other kinds with zero relevance and handles all-zero latency", () => {
    const ranked = ranker.rank(
      [
        svc({ id: "svc_courier", kind: "COURIER", avgLatencyMs: 0 }),
        svc({ id: "svc_scout", avgLatencyMs: 0 }),
      ],
      { taskKind: "SCOUT", tick: 1 },
    );
    expect(ranked.map((r) => r.id)).toEqual(["svc_scout", "svc_courier"]);
    expect(ranked[1]?.components.taskRelevance).toBe(0);
    expect(ranked[1]?.score).toBeLessThan(0);
    expect(ranked.every((r) => r.components.normalizedLatency === 0)).toBe(true);
  });

  it("decays freshness with age and rewards recent calls", () => {
    expect(freshness(null, 100)).toBe(0.7);
    expect(freshness(100, 100)).toBe(1);
    expect(freshness(50, 100)).toBeCloseTo(0.5 + 0.5 * Math.exp(-1), 12);
    expect(freshness(0, 10_000)).toBeCloseTo(0.5, 6);
    expect(successRate(0, 0)).toBe(0.5);
    expect(successRate(9, 1)).toBeCloseTo(10 / 12, 12);
  });

  it("honours custom weights", () => {
    const priceBlind = new BaselineServiceRanker({ price: 0 });
    const ranked = priceBlind.rank(
      [svc({ id: "svc_cheap", priceDrops: 1n }), svc({ id: "svc_dear", priceDrops: 1_000_000n })],
      { taskKind: "SCOUT", tick: 1 },
    );
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
    expect(ranked.map((r) => r.id)).toEqual(["svc_cheap", "svc_dear"]);
  });
});
