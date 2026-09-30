import type { X402PaymentRequirements } from "@aigentia/protocol";
import { AigentiaError, isDropsString, sha256Hex, utf8ToHex } from "@aigentia/shared";

/** Flags a presigned x402 Payment may carry: none, or only tfFullyCanonicalSig. */
const ALLOWED_FLAGS = new Set([0, 0x80000000]);
const FORBIDDEN_FIELDS = [
  "SendMax",
  "DeliverMin",
  "Paths",
  "TicketSequence",
  "Signers",
  "TxnSignature",
  "SigningPubKey",
  "AccountTxnID",
  "Delegate",
] as const;

function refuse(reason: string, details: Record<string, unknown> = {}): never {
  throw new AigentiaError("X402_UNTRUSTED", `refusing to sign x402 payment: ${reason}`, {
    reason,
    ...details,
  });
}

function memoDatas(tx: Record<string, unknown>): string[] {
  const memos = tx["Memos"];
  if (!Array.isArray(memos)) return [];
  const out: string[] = [];
  for (const m of memos) {
    const data = (m as { Memo?: { MemoData?: unknown } } | null)?.Memo?.MemoData;
    if (typeof data === "string") out.push(data.toUpperCase());
  }
  return out;
}

/**
 * The payment service builds the unsigned transaction, so the buyer never signs it blindly:
 * it must be exactly the Payment the validated requirements describe, from the buyer's own
 * account, bound to the invoice, with a bounded fee and no feature that could move a
 * different amount (partial payments, paths, SendMax…).
 */
export function assertUnsignedPaymentMatches(
  unsignedTx: Record<string, unknown>,
  expect: {
    readonly account: string;
    readonly requirements: X402PaymentRequirements;
    readonly invoiceId: string;
    readonly maxFeeDrops: bigint;
    readonly networkId: number;
  },
): void {
  const { requirements: req } = expect;
  if (unsignedTx["TransactionType"] !== "Payment") refuse("not_a_payment");
  if (unsignedTx["Account"] !== expect.account) refuse("account_mismatch");
  if (unsignedTx["Destination"] !== req.payTo) refuse("destination_mismatch");
  if (req.asset !== "XRP") refuse("asset_not_supported", { asset: req.asset });
  if (typeof unsignedTx["Amount"] !== "string" || unsignedTx["Amount"] !== req.amount) {
    refuse("amount_mismatch", { amount: unsignedTx["Amount"], expected: req.amount });
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (unsignedTx[field] !== undefined && unsignedTx[field] !== "")
      refuse("forbidden_field", { field });
  }
  const flags = unsignedTx["Flags"];
  if (flags !== undefined && (typeof flags !== "number" || !ALLOWED_FLAGS.has(flags))) {
    refuse("forbidden_flags", { flags });
  }
  const fee = unsignedTx["Fee"];
  if (!isDropsString(fee) || BigInt(fee) < 1n || BigInt(fee) > expect.maxFeeDrops) {
    refuse("fee_out_of_bounds", { fee, maxFeeDrops: expect.maxFeeDrops.toString() });
  }
  if (typeof unsignedTx["Sequence"] !== "number") refuse("missing_sequence");
  if (typeof unsignedTx["LastLedgerSequence"] !== "number") refuse("missing_last_ledger_sequence");

  const invoiceField = sha256Hex(expect.invoiceId).toUpperCase();
  const boundByField = String(unsignedTx["InvoiceID"] ?? "").toUpperCase() === invoiceField;
  const boundByMemo = memoDatas(unsignedTx).includes(utf8ToHex(expect.invoiceId));
  if (!boundByField && !boundByMemo) refuse("invoice_not_bound");
  if (unsignedTx["InvoiceID"] !== undefined && !boundByField) refuse("invoice_field_mismatch");

  const sourceTag = req.extra?.sourceTag;
  if (sourceTag !== undefined && unsignedTx["SourceTag"] !== sourceTag) {
    refuse("source_tag_mismatch", { sourceTag: unsignedTx["SourceTag"], expected: sourceTag });
  }
  if (
    unsignedTx["DestinationTag"] !== undefined &&
    unsignedTx["DestinationTag"] !== req.extra?.destinationTag
  ) {
    refuse("destination_tag_mismatch");
  }
  const networkId = unsignedTx["NetworkID"];
  if (networkId !== undefined && networkId !== expect.networkId)
    refuse("network_mismatch", { networkId });
}
