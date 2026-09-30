/**
 * Presentation helpers. Money is a drops string on the wire (1 XRP = 1,000,000 drops);
 * we never touch floating point for money, only for chart scales.
 */
export const DROPS_PER_XRP = 1_000_000n;
export const DEFAULT_EXPLORER_URL = "https://testnet.xrpl.org";

const DROPS_RE = /^-?(0|[1-9][0-9]*)$/;

/** Parse a drops string/bigint/number safely; returns null on anything malformed. */
export function parseDropsSafe(value: string | bigint | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  const trimmed = value.trim();
  if (!DROPS_RE.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface FormatXrpOptions {
  /** Maximum fraction digits (0..6). Trailing zeros are trimmed. Default 6. */
  readonly maxFraction?: number;
  /** Minimum fraction digits kept. Default 0. */
  readonly minFraction?: number;
  /** Append " XRP". Default false. */
  readonly unit?: boolean;
  /** Prefix + for positive values (deltas). Default false. */
  readonly signed?: boolean;
}

/**
 * Format a drops amount as XRP with thousands separators, e.g. "1,234.5" or "0.000001".
 * Returns "—" for malformed input.
 */
export function formatXrp(
  drops: string | bigint | number | null | undefined,
  options: FormatXrpOptions = {},
): string {
  const parsed = parseDropsSafe(drops);
  if (parsed === null) return "—";
  const maxFraction = Math.min(6, Math.max(0, options.maxFraction ?? 6));
  const minFraction = Math.min(maxFraction, Math.max(0, options.minFraction ?? 0));
  const negative = parsed < 0n;
  const abs = negative ? -parsed : parsed;
  const whole = abs / DROPS_PER_XRP;
  let frac = (abs % DROPS_PER_XRP).toString().padStart(6, "0").slice(0, maxFraction);
  frac = frac.replace(/0+$/, "");
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, "0");
  const sign = negative ? "-" : options.signed && parsed > 0n ? "+" : "";
  const body =
    frac.length > 0
      ? `${groupThousands(whole.toString())}.${frac}`
      : groupThousands(whole.toString());
  return `${sign}${body}${options.unit ? " XRP" : ""}`;
}

/** Compact XRP for hero tiles: "1.2M", "42.5K", "12.3", "0.0042". */
export function formatXrpCompact(drops: string | bigint | number | null | undefined): string {
  const parsed = parseDropsSafe(drops);
  if (parsed === null) return "—";
  const xrp = Number(parsed) / 1_000_000;
  const abs = Math.abs(xrp);
  if (abs >= 1_000_000_000) return `${(xrp / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(xrp / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(xrp / 1_000).toFixed(1)}K`;
  if (abs >= 100) return xrp.toFixed(1);
  if (abs >= 1) return xrp.toFixed(2);
  if (abs === 0) return "0";
  return xrp.toFixed(4);
}

/** Drops → XRP as a JS number (for chart scales only, never for money arithmetic). */
export function dropsToXrpNumber(drops: string | bigint | number | null | undefined): number {
  const parsed = parseDropsSafe(drops);
  if (parsed === null) return 0;
  return Number(parsed) / 1_000_000;
}

/** Sum drops strings; malformed entries are skipped. */
export function sumDrops(values: ReadonlyArray<string | bigint | null | undefined>): bigint {
  let total = 0n;
  for (const v of values) {
    const parsed = parseDropsSafe(v);
    if (parsed !== null) total += parsed;
  }
  return total;
}

/** Compare two drops strings (descending sort helper): returns b - a sign. */
export function compareDropsDesc(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const x = parseDropsSafe(a) ?? 0n;
  const y = parseDropsSafe(b) ?? 0n;
  return x === y ? 0 : x < y ? 1 : -1;
}

/** rQ4x…8kLm */
export function shortAddress(address: string | null | undefined, head = 6, tail = 4): string {
  if (!address) return "—";
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** 3F1A…9C0D (upper-cased hash) */
export function shortHash(hash: string | null | undefined, head = 6, tail = 4): string {
  if (!hash) return "—";
  const upper = hash.toUpperCase();
  if (upper.length <= head + tail + 1) return upper;
  return `${upper.slice(0, head)}…${upper.slice(-tail)}`;
}

/** Relative time: "just now", "42s ago", "3m ago", "5h ago", "2d ago". Future → "in 3m". */
export function timeAgo(iso: string | Date | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = iso instanceof Date ? iso : new Date(iso);
  const t = then.getTime();
  if (Number.isNaN(t)) return "—";
  const diffMs = now.getTime() - t;
  const future = diffMs < 0;
  const s = Math.floor(Math.abs(diffMs) / 1000);
  let label: string;
  if (s < 5) return "just now";
  if (s < 60) label = `${s}s`;
  else if (s < 3600) label = `${Math.floor(s / 60)}m`;
  else if (s < 86_400) label = `${Math.floor(s / 3600)}h`;
  else if (s < 86_400 * 30) label = `${Math.floor(s / 86_400)}d`;
  else label = `${Math.floor(s / (86_400 * 30))}mo`;
  return future ? `in ${label}` : `${label} ago`;
}

/** Countdown formatting: "02:14:07" or "3d 04:00:00"; "00:00:00" once elapsed. */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hms = [h, m, s].map((n) => n.toString().padStart(2, "0")).join(":");
  return days > 0 ? `${days}d ${hms}` : hms;
}

/** "2026-09-30 14:03:07 UTC" */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function formatNumber(value: number | null | undefined, maxFraction = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFraction }).format(value);
}

/** 0.42 → "42.0%" */
export function formatPercent(ratio: number | null | undefined, fraction = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(fraction)}%`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** "maximize_net_worth" → "maximize net worth" */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/[_-]+/g, " ").toLowerCase();
}

// ── Explorer links ───────────────────────────────────────────────────────────

/** Explorer base URL without a trailing slash. */
export function explorerBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_XRPL_EXPLORER_URL;
  const base = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_EXPLORER_URL;
  return base.replace(/\/+$/, "");
}

export function explorerTxUrl(txHash: string): string {
  return `${explorerBaseUrl()}/transactions/${encodeURIComponent(txHash)}`;
}

export function explorerAccountUrl(address: string): string {
  return `${explorerBaseUrl()}/accounts/${encodeURIComponent(address)}`;
}

export type LedgerKind = "testnet" | "mock";

/**
 * Resolve the link for a transaction. Mock-ledger items never link anywhere; a DTO
 * that carries its own explorerUrl wins over the locally built one.
 */
export function resolveTxLink(input: {
  txHash: string | null | undefined;
  ledger?: LedgerKind | null;
  explorerUrl?: string | null;
}): { href: string | null; mock: boolean } {
  if (!input.txHash) return { href: null, mock: input.ledger === "mock" };
  if (input.ledger === "mock") return { href: null, mock: true };
  if (typeof input.explorerUrl === "string" && input.explorerUrl.length > 0) {
    return { href: input.explorerUrl, mock: false };
  }
  if (input.explorerUrl === null && input.ledger === undefined) {
    // The API explicitly says "no explorer" (mock receipt) even though we lack the ledger tag.
    return { href: null, mock: true };
  }
  return { href: explorerTxUrl(input.txHash), mock: false };
}
