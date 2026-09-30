import { DROPS_PER_XRP, type AssetCode } from "./constants";

/**
 * Asset descriptor. XRP is native; issued currencies (e.g. RLUSD) carry an issuer.
 * Designed so RLUSD can be added without rewriting the economy: everything that
 * moves value is typed as `Money`, never as a bare number.
 */
export type Asset =
  | { readonly code: "XRP" }
  | {
      readonly code: Exclude<AssetCode, "XRP">;
      readonly issuer: string;
      readonly currencyHex: string;
    };

export const XRP: Asset = { code: "XRP" };

/**
 * Money is an asset plus an amount expressed in the asset's ledger unit as a string:
 *   - XRP: integer drops ("1000000" == 1 XRP)
 *   - issued currencies: decimal value string ("1.25")
 * Strings avoid floating point and mirror the x402-xrpl wire format.
 */
export interface Money {
  readonly asset: Asset;
  readonly value: string;
}

export function isXrp(asset: Asset): asset is { readonly code: "XRP" } {
  return asset.code === "XRP";
}

export function assetKey(asset: Asset): string {
  return isXrp(asset) ? "XRP" : `${asset.code}.${asset.issuer}`;
}

export function sameAsset(a: Asset, b: Asset): boolean {
  return assetKey(a) === assetKey(b);
}

const DROPS_RE = /^(0|[1-9][0-9]*)$/;

export function isDropsString(value: unknown): value is string {
  return (
    typeof value === "string" && DROPS_RE.test(value) && BigInt(value) <= 100_000_000_000_000_000n
  );
}

export function parseDrops(value: string | number | bigint): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError("drops must be non-negative");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0)
      throw new RangeError(`invalid drops number: ${value}`);
    return BigInt(value);
  }
  if (!isDropsString(value)) throw new RangeError(`invalid drops string: ${value}`);
  return BigInt(value);
}

export function xrpToDrops(xrp: string | number): bigint {
  const s = typeof xrp === "number" ? xrp.toFixed(6) : xrp.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new RangeError(`invalid XRP amount: ${xrp}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole ?? "0") * DROPS_PER_XRP + BigInt(frac.padEnd(6, "0"));
}

export function dropsToXrp(drops: bigint | string | number): string {
  const d = parseDrops(drops);
  const whole = d / DROPS_PER_XRP;
  const frac = (d % DROPS_PER_XRP).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}

export function xrp(drops: bigint | string | number): Money {
  return { asset: XRP, value: parseDrops(drops).toString() };
}

export function money(asset: Asset, value: string): Money {
  if (isXrp(asset)) return xrp(value);
  if (!/^\d+(\.\d+)?$/.test(value)) throw new RangeError(`invalid issued amount: ${value}`);
  return { asset, value };
}

/** Human readable, e.g. "0.001 XRP". */
export function formatMoney(m: Money): string {
  return isXrp(m.asset) ? `${dropsToXrp(m.value)} XRP` : `${m.value} ${m.asset.code}`;
}

export function moneyToDrops(m: Money): bigint {
  if (!isXrp(m.asset)) throw new RangeError("moneyToDrops only applies to XRP");
  return parseDrops(m.value);
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  if (!sameAsset(a.asset, b.asset)) throw new RangeError("cannot compare different assets");
  if (isXrp(a.asset)) {
    const x = parseDrops(a.value);
    const y = parseDrops(b.value);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = Number(a.value);
  const y = Number(b.value);
  return x < y ? -1 : x > y ? 1 : 0;
}
