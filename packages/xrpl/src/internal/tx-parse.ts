import { hexToUtf8, rippleTimeToDate } from "@aigentia/shared";
import type { LedgerTransaction } from "../types";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === "string" ? v : null;
}

export function getNumber(rec: Record<string, unknown> | null, key: string): number | null {
  const v = rec?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function getBoolean(rec: Record<string, unknown> | null, key: string): boolean | null {
  const v = rec?.[key];
  return typeof v === "boolean" ? v : null;
}

/** Hex MemoData of every memo on a transaction, upper-cased. */
export function memoDataHex(tx: Record<string, unknown>): string[] {
  const memos = tx["Memos"];
  if (!Array.isArray(memos)) return [];
  const out: string[] = [];
  for (const entry of memos) {
    const memo = asRecord(asRecord(entry)?.["Memo"]);
    const data = getString(memo, "MemoData");
    if (data) out.push(data.toUpperCase());
  }
  return out;
}

/** UTF-8 decoded first memo, or null. */
export function firstMemoText(tx: Record<string, unknown>): string | null {
  const first = memoDataHex(tx)[0];
  if (!first || !/^[0-9A-F]*$/.test(first)) return null;
  try {
    return hexToUtf8(first);
  } catch {
    return null;
  }
}

/** Close time from `close_time_iso` or the ripple-epoch `date` field. */
export function closeTimeFrom(
  container: Record<string, unknown> | null,
  tx: Record<string, unknown> | null,
): Date | null {
  const iso = getString(container, "close_time_iso") ?? getString(tx, "close_time_iso");
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const rippleDate = getNumber(container, "date") ?? getNumber(tx, "date");
  return rippleDate === null ? null : rippleTimeToDate(rippleDate);
}

/**
 * Normalise a rippled `tx` result (API v1 fields at top level, or v2 `tx_json`) into a
 * LedgerTransaction. Binary metadata (string) is treated as absent.
 */
export function ledgerTransactionFromTxResult(
  result: Record<string, unknown>,
  fallbackHash: string,
): LedgerTransaction {
  const txJson = asRecord(result["tx_json"]);
  const tx: Record<string, unknown> = txJson ?? stripResultEnvelope(result);
  const meta = asRecord(result["meta"]) ?? asRecord(result["meta_blob"]);
  return {
    hash: getString(result, "hash") ?? getString(tx, "hash") ?? fallbackHash,
    ledgerIndex: getNumber(result, "ledger_index") ?? getNumber(tx, "ledger_index"),
    validated: getBoolean(result, "validated") ?? false,
    closeTime: closeTimeFrom(result, tx),
    tx,
    meta,
  };
}

/** Normalise one `account_tx` entry (v1 `tx` or v2 `tx_json`). */
export function ledgerTransactionFromAccountTxEntry(
  entry: Record<string, unknown>,
): LedgerTransaction | null {
  const tx = asRecord(entry["tx_json"]) ?? asRecord(entry["tx"]);
  if (!tx) return null;
  const hash = getString(entry, "hash") ?? getString(tx, "hash");
  if (!hash) return null;
  return {
    hash,
    ledgerIndex: getNumber(entry, "ledger_index") ?? getNumber(tx, "ledger_index"),
    validated: getBoolean(entry, "validated") ?? false,
    closeTime: closeTimeFrom(entry, tx),
    tx,
    meta: asRecord(entry["meta"]),
  };
}

const ENVELOPE_KEYS = new Set([
  "meta",
  "meta_blob",
  "validated",
  "ledger_index",
  "ledger_hash",
  "close_time_iso",
  "ctid",
  "date",
  "inLedger",
  "hash",
  "status",
  "searched_all",
]);

function stripResultEnvelope(result: Record<string, unknown>): Record<string, unknown> {
  const tx: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (!ENVELOPE_KEYS.has(k)) tx[k] = v;
  }
  return tx;
}

/** Plain JSON copy (drops undefined, keeps order) so `raw` is serialisable. */
export function toPlainJson(value: unknown): Record<string, unknown> {
  const rec = asRecord(value);
  if (!rec) return {};
  return JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
}
