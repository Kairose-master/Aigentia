import { describe, expect, it } from "vitest";
import { SeededRandom } from "@aigentia/shared";
import { computeNetWorthDrops } from "./net-worth";
import { initialMarketQuote, quoteMarket, stepMarketPrice, type MarketQuote } from "./pricing";

const BASE = 1_000_000n;

function simulate(seed: string, supply: number, netDemand: number, ticks: number): MarketQuote[] {
  const rng = new SeededRandom(seed);
  let quote = initialMarketQuote(BASE);
  const out: MarketQuote[] = [];
  for (let i = 0; i < ticks; i++) {
    quote = stepMarketPrice({ ...quote, supply, base: BASE, netDemand, rng });
    out.push(quote);
  }
  return out;
}

const mid = (q: MarketQuote): number => Number(q.bidDrops + q.askDrops) / 2;

describe("world market pricing", () => {
  it("opens at the base price with the minimum spread", () => {
    const q = initialMarketQuote(BASE);
    expect(q).toEqual({ bidDrops: 980_000n, askDrops: 1_020_000n });
  });

  it("is deterministic for the same seed and diverges for another", () => {
    const a = simulate("market-seed", 100, 0, 50);
    const b = simulate("market-seed", 100, 0, 50);
    const c = simulate("other-seed", 100, 0, 50);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("keeps at least a 4% spread and positive prices", () => {
    for (const q of simulate("spread", 100, 0, 200)) {
      expect(q.bidDrops).toBeGreaterThan(0n);
      expect(q.askDrops).toBeGreaterThan(q.bidDrops);
      expect(Number(q.askDrops - q.bidDrops) / mid(q)).toBeGreaterThanOrEqual(0.04 - 1e-9);
    }
    const tiny = stepMarketPrice({
      bidDrops: 1n,
      askDrops: 1n,
      supply: 100_000,
      base: 1n,
      netDemand: 0,
      rng: new SeededRandom("tiny"),
    });
    expect(tiny.bidDrops).toBeGreaterThanOrEqual(1n);
    expect(tiny.askDrops).toBeGreaterThan(tiny.bidDrops);
  });

  it("mean-reverts toward a supply-adjusted target with bounded noise", () => {
    const glut = simulate("glut", 400, 0, 100);
    const scarcity = simulate("scarcity", 10, 0, 100);
    const balanced = simulate("balanced", 100, 0, 100);
    const last = (series: MarketQuote[]): number => mid(series[series.length - 1]!);
    expect(last(glut)).toBeLessThan(Number(BASE) * 0.6);
    expect(last(scarcity)).toBeGreaterThan(Number(BASE) * 1.2);
    expect(Math.abs(last(balanced) - Number(BASE)) / Number(BASE)).toBeLessThan(0.05);

    // Each single step moves at most reversion + demand + noise; with no demand and
    // balanced supply the change is driven by the ±2% noise band alone.
    let prev = initialMarketQuote(BASE);
    const rng = new SeededRandom("noise");
    for (let i = 0; i < 100; i++) {
      const next = stepMarketPrice({ ...prev, supply: 100, base: BASE, netDemand: 0, rng });
      const drift = Math.abs(mid(next) - mid(prev)) / mid(prev);
      expect(drift).toBeLessThanOrEqual(0.1 + 0.02 + 1e-6);
      prev = next;
    }
  });

  it("lets net demand push the price and never leaves the swing band", () => {
    const rng = new SeededRandom("demand");
    const start = initialMarketQuote(BASE);
    const up = stepMarketPrice({ ...start, supply: 100, base: BASE, netDemand: 200, rng });
    const flat = stepMarketPrice({
      ...start,
      supply: 100,
      base: BASE,
      netDemand: 0,
      rng: new SeededRandom("demand"),
    });
    expect(mid(up)).toBeGreaterThan(mid(flat));
    const runaway = simulate("runaway", 0, 100_000, 300);
    for (const q of runaway) expect(mid(q)).toBeLessThanOrEqual(Number(BASE) * 3 * 1.03);
  });

  it("rejects a non-positive base price", () => {
    expect(() =>
      stepMarketPrice({
        bidDrops: 1n,
        askDrops: 2n,
        supply: 1,
        base: 0n,
        netDemand: 0,
        rng: new SeededRandom("x"),
      }),
    ).toThrow(/base price/);
  });

  it("quotes buys at the ask and sells at the bid", () => {
    const price = { bidDrops: 980_000n, askDrops: 1_020_000n };
    expect(quoteMarket(price, 3, "buy")).toEqual({
      side: "buy",
      quantity: 3,
      unitPriceDrops: 1_020_000n,
      totalDrops: 3_060_000n,
    });
    expect(quoteMarket(price, 2, "sell").totalDrops).toBe(1_960_000n);
    expect(() => quoteMarket(price, 0, "buy")).toThrow(/quantity/);
    expect(() => quoteMarket(price, 1.5, "sell")).toThrow(/quantity/);
  });
});

describe("computeNetWorthDrops", () => {
  it("adds inventory at the market bid and ignores unpriced or empty lines", () => {
    const worth = computeNetWorthDrops({
      balanceDrops: 5_000_000n,
      inventory: [
        { resourceType: "ore", quantity: 10 },
        { resourceType: "data", quantity: 0 },
        { resourceType: "alloy", quantity: 3 },
        { resourceType: "energy", quantity: -4 },
      ],
      marketPrices: { ore: { bidDrops: 100_000n }, energy: { bidDrops: 50_000n } },
    });
    expect(worth).toBe(5_000_000n + 10n * 100_000n);
    expect(computeNetWorthDrops({ balanceDrops: 7n, inventory: [], marketPrices: {} })).toBe(7n);
  });
});
