import type { X402PaymentPayload, X402PaymentRequirements } from "@aigentia/protocol";
import { sha256Hex, stableStringify, utf8ToHex } from "@aigentia/shared";
import { decode, hashes, verifySignature } from "xrpl";

export interface DecodedPresigned {
  readonly tx: Record<string, unknown>;
  readonly hash: string;
}

/** Decode a signed blob and compute its transaction hash; null when undecodable. */
export function decodePresigned(signedTxBlob: string): DecodedPresigned | null {
  try {
    const tx = decode(signedTxBlob) as Record<string, unknown>;
    return { tx, hash: hashes.hashSignedTx(signedTxBlob) };
  } catch {
    return null;
  }
}

function sameRequirements(a: X402PaymentRequirements, b: X402PaymentRequirements): boolean {
  const pick = (r: X402PaymentRequirements) => ({
    scheme: r.scheme,
    network: r.network,
    amount: r.amount,
    asset: r.asset,
    payTo: r.payTo,
    invoiceId: r.extra?.invoiceId ?? null,
  });
  return stableStringify(pick(a)) === stableStringify(pick(b));
}

/**
 * Offline checks of the XRPL "exact" presigned-Payment scheme: the same rules the Python
 * facilitator enforces before touching the ledger. Returns an invalid reason or null.
 * `requirements` must be the SELLER's stored quote, never the buyer's copy.
 */
export function checkPresignedPayment(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
  network: string,
): string | null {
  if (payload.x402Version !== 2) return "unsupported_x402_version";
  if (requirements.scheme !== "exact") return "unsupported_scheme";
  if (requirements.network !== network) return "unsupported_network";
  if (!sameRequirements(payload.accepted, requirements)) return "requirements_mismatch";
  const invoiceId = requirements.extra?.invoiceId;
  if (!invoiceId || payload.payload.invoiceId !== invoiceId) return "invoice_mismatch";
  const decoded = decodePresigned(payload.payload.signedTxBlob);
  if (!decoded) return "invalid_tx_blob";
  const { tx } = decoded;
  if (tx["TransactionType"] !== "Payment") return "invalid_transaction_type";
  let signatureOk = false;
  try {
    signatureOk = verifySignature(payload.payload.signedTxBlob);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return "invalid_signature";
  if (tx["Destination"] !== requirements.payTo) return "destination_mismatch";
  if (requirements.asset !== "XRP" || typeof tx["Amount"] !== "string") return "asset_mismatch";
  if (tx["Amount"] !== requirements.amount) return "amount_mismatch";
  for (const f of ["SendMax", "DeliverMin", "Paths"])
    if (tx[f] !== undefined) return "unsupported_payment_features";
  const flags = typeof tx["Flags"] === "number" ? tx["Flags"] : 0;
  if ((flags & 0x00020000) !== 0) return "partial_payment_not_allowed";
  const memoHex = utf8ToHex(invoiceId);
  const memos = Array.isArray(tx["Memos"])
    ? (tx["Memos"] as { Memo?: { MemoData?: string } }[])
    : [];
  const byMemo = memos.some((m) => m.Memo?.MemoData?.toUpperCase() === memoHex);
  const byField =
    String(tx["InvoiceID"] ?? "").toUpperCase() === sha256Hex(invoiceId).toUpperCase();
  if (!byMemo && !byField) return "invoice_binding_missing";
  const sourceTag = requirements.extra?.sourceTag;
  if (sourceTag !== undefined && tx["SourceTag"] !== sourceTag) return "source_tag_mismatch";
  if (typeof tx["LastLedgerSequence"] !== "number") return "missing_last_ledger_sequence";
  return null;
}
