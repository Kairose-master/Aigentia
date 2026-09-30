import { AigentiaError, type SeededRandom } from "@aigentia/shared";

export interface MarketQuote {
  /** What the market pays when an agent sells to it. */
  readonly bidDrops: bigint;
  /** What the market charges when an agent buys from it. */
  readonly askDrops: bigint;
}

export interface MarketModelOptions {
  /** Fraction of the gap to the supply-adjusted target closed per step. */
  readonly reversion: number;
  /** Supply level at which the target equals the base price. */
  readonly equilibriumSupply: number;
  /** Strength of the supply effect on the target (exp(−k·(supply−eq)/eq)). */
  readonly supplyElasticity: number;
  /** Price impact per unit of net demand, relative to equilibrium supply. */
  readonly demandImpact: number;
  /** Half-width of the uniform noise band, e.g. 0.02 for ±2%. */
  readonly noise: number;
  /** Minimum relative bid/ask spread. */
  readonly minSpread: number;
  /** Target never leaves [base/maxSwing, base·maxSwing]. */
  readonly maxSwing: number;
}

export const DEFAULT_MARKET_MODEL: MarketModelOptions = {
  reversion: 0.1,
  equilibriumSupply: 100,
  supplyElasticity: 0.35,
  demandImpact: 0.05,
  noise: 0.02,
  minSpread: 0.04,
  maxSwing: 3,
};

export interface MarketStepInput {
  readonly bidDrops: bigint;
  readonly askDrops: bigint;
  /** Units currently held by the world market. */
  readonly supply: number;
  /** Fundamental price (drops per unit) the market reverts toward. */
  readonly base: bigint;
  /** Units bought from the market minus units sold to it this tick. */
  readonly netDemand: number;
  readonly rng: SeededRandom;
  readonly options?: Partial<MarketModelOptions>;
}

function toDrops(value: number): bigint {
  if (!Number.isFinite(value)) return 1n;
  const rounded = Math.round(value);
  return rounded < 1 ? 1n : BigInt(rounded);
}

/** Opening quote for a resource: base price with the minimum spread around it. */
export function initialMarketQuote(
  base: bigint,
  minSpread: number = DEFAULT_MARKET_MODEL.minSpread,
): MarketQuote {
  return spreadAround(Number(base), minSpread);
}

function spreadAround(mid: number, spread: number): MarketQuote {
  const half = spread / 2;
  const bid = toDrops(mid * (1 - half));
  let ask = toDrops(mid * (1 + half));
  const minGap = toDrops(Math.ceil(mid * spread));
  if (ask - bid < minGap) ask = bid + minGap;
  return { bidDrops: bid, askDrops: ask };
}

/**
 * One tick of the deterministic world market. The mid price mean-reverts toward a target
 * that falls as supply rises above equilibrium (and rises as it falls below), gets a nudge
 * from this tick's net demand, then takes ±`noise` seeded jitter. Same inputs + same RNG
 * state ⇒ same quote. The quote always keeps at least `minSpread` between bid and ask.
 */
export function stepMarketPrice(input: MarketStepInput): MarketQuote {
  const o = { ...DEFAULT_MARKET_MODEL, ...input.options };
  if (input.base <= 0n) {
    throw new AigentiaError("VALIDATION_FAILED", "base price must be positive", {
      base: input.base.toString(),
    });
  }
  const base = Number(input.base);
  const mid = (Number(input.bidDrops) + Number(input.askDrops)) / 2 || base;
  const eq = Math.max(1, o.equilibriumSupply);
  const supplyGap = (Math.max(0, input.supply) - eq) / eq;
  const rawTarget = base * Math.exp(-o.supplyElasticity * supplyGap);
  const target = Math.min(base * o.maxSwing, Math.max(base / o.maxSwing, rawTarget));
  const demandNudge = mid * o.demandImpact * (input.netDemand / eq);
  const drifted = mid + o.reversion * (target - mid) + demandNudge;
  const jitter = (input.rng.next() * 2 - 1) * o.noise;
  const next = Math.min(base * o.maxSwing, Math.max(base / o.maxSwing, drifted * (1 + jitter)));
  return spreadAround(next, o.minSpread);
}

export type MarketSide = "buy" | "sell";

export interface MarketOrderQuote {
  readonly side: MarketSide;
  readonly quantity: number;
  readonly unitPriceDrops: bigint;
  readonly totalDrops: bigint;
}

/** Cost (buy at ask) or proceeds (sell at bid) of trading `quantity` units with the market. */
export function quoteMarket(
  price: MarketQuote,
  quantity: number,
  side: MarketSide,
): MarketOrderQuote {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new AigentiaError("VALIDATION_FAILED", "quantity must be a positive integer", {
      quantity,
    });
  }
  const unitPriceDrops = side === "buy" ? price.askDrops : price.bidDrops;
  return { side, quantity, unitPriceDrops, totalDrops: unitPriceDrops * BigInt(quantity) };
}
