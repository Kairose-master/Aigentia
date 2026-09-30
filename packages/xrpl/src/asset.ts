import {
  AigentiaError,
  XRP,
  isXrp,
  money,
  parseDrops,
  type Asset,
  type Money,
} from "@aigentia/shared";

/** 160-bit XRPL currency code for RLUSD ("RLUSD" padded with zeros). */
export const RLUSD_CURRENCY_HEX = "524C555344000000000000000000000000000000";

export interface XrplIssuedAmount {
  readonly currency: string;
  readonly issuer: string;
  readonly value: string;
}

export type XrplAmount = string | XrplIssuedAmount;

/** Encode a Money as an xrpl.js Amount: drops string for XRP, issued-currency object otherwise. */
export function moneyToXrplAmount(m: Money): XrplAmount {
  if (isXrp(m.asset)) return parseDrops(m.value).toString();
  return { currency: m.asset.currencyHex, issuer: m.asset.issuer, value: m.value };
}

/** Decode an xrpl.js Amount into Money. Throws VALIDATION_FAILED for unknown shapes (MPT, unknown currency). */
export function xrplAmountToMoney(amount: unknown): Money {
  const parsed = tryXrplAmountToMoney(amount);
  if (!parsed) {
    throw new AigentiaError("VALIDATION_FAILED", "unsupported XRPL amount", {
      amount: typeof amount === "string" ? amount : JSON.stringify(amount),
    });
  }
  return parsed;
}

/** Like xrplAmountToMoney but returns null instead of throwing. */
export function tryXrplAmountToMoney(amount: unknown): Money | null {
  if (typeof amount === "string") {
    return /^(0|[1-9][0-9]*)$/.test(amount) ? money(XRP, amount) : null;
  }
  if (!amount || typeof amount !== "object") return null;
  const { currency, issuer, value } = amount as Record<string, unknown>;
  if (typeof currency !== "string" || typeof issuer !== "string" || typeof value !== "string")
    return null;
  const code = currencyToCode(currency);
  if (!code || code === "XRP") return null;
  try {
    return money({ code, issuer, currencyHex: normaliseCurrencyHex(currency) }, value);
  } catch {
    return null;
  }
}

/** Build an Asset from a code; issued currencies need their issuer address. */
export function assetFromCode(code: string, issuer?: string): Asset {
  if (code === "XRP") return XRP;
  if (code === "RLUSD") {
    if (!issuer) {
      throw new AigentiaError("VALIDATION_FAILED", "RLUSD requires an issuer address", { code });
    }
    return { code: "RLUSD", issuer, currencyHex: RLUSD_CURRENCY_HEX };
  }
  throw new AigentiaError("VALIDATION_FAILED", `unsupported asset code: ${code}`, { code });
}

/** Map a 3-letter or 40-hex XRPL currency to a known asset code. */
export function currencyToCode(currency: string): Asset["code"] | null {
  const upper = currency.toUpperCase();
  if (upper === "XRP") return "XRP";
  if (upper === "RLUSD" || upper === RLUSD_CURRENCY_HEX) return "RLUSD";
  return null;
}

function normaliseCurrencyHex(currency: string): string {
  if (/^[0-9A-Fa-f]{40}$/.test(currency)) return currency.toUpperCase();
  return Buffer.from(currency, "ascii").toString("hex").toUpperCase().padEnd(40, "0");
}
