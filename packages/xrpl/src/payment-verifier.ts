import { AigentiaError, isXrp, sha256Hex, utf8ToHex, type Money } from "@aigentia/shared";
import { tryXrplAmountToMoney } from "./asset";
import { rippledErrorCode } from "./client";
import {
  asRecord,
  getNumber,
  getString,
  ledgerTransactionFromTxResult,
  memoDataHex,
} from "./internal/tx-parse";
import type {
  LedgerKind,
  LedgerTransaction,
  PaymentExpectation,
  PaymentVerifier,
  VerifiedPayment,
  XrplRequestClient,
} from "./types";

/** InvoiceID field value for an invoice id: SHA-256 hex, upper-case. */
export function invoiceIdToInvoiceField(invoiceId: string): string {
  return sha256Hex(invoiceId).toUpperCase();
}

function unverified(reason: string, details: Record<string, unknown>): never {
  throw new AigentiaError("PAYMENT_UNVERIFIED", reason, details);
}

function moneyEquals(a: Money, b: Money): boolean {
  if (isXrp(a.asset) !== isXrp(b.asset)) return false;
  if (isXrp(a.asset) && isXrp(b.asset)) return BigInt(a.value) === BigInt(b.value);
  if (isXrp(a.asset) || isXrp(b.asset)) return false;
  return (
    a.asset.issuer === b.asset.issuer &&
    a.asset.currencyHex.toUpperCase() === b.asset.currencyHex.toUpperCase() &&
    Number(a.value) === Number(b.value)
  );
}

/**
 * Pure verification of a fetched transaction against an expectation. Shared by the real
 * verifier and the MockLedger so both enforce exactly the same rules.
 */
export function verifyLedgerTransaction(
  found: LedgerTransaction,
  expect: PaymentExpectation,
  ledger: LedgerKind,
): VerifiedPayment {
  const { hash, tx, meta } = found;
  const base = { txHash: hash, ledger };
  if (!found.validated) unverified("transaction is not validated", base);
  if (tx["TransactionType"] !== "Payment")
    unverified("transaction is not a Payment", { ...base, transactionType: tx["TransactionType"] });
  const result = getString(meta, "TransactionResult");
  if (result !== "tesSUCCESS") unverified("transaction did not succeed", { ...base, result });
  if (found.ledgerIndex === null) unverified("transaction has no ledger index", base);

  const destination = getString(tx, "Destination");
  if (destination !== expect.destination)
    unverified("destination mismatch", {
      ...base,
      expected: expect.destination,
      actual: destination,
    });

  const sender = getString(tx, "Account");
  if (!sender) unverified("transaction has no Account", base);
  if (expect.sender !== undefined && sender !== expect.sender)
    unverified("sender mismatch", { ...base, expected: expect.sender, actual: sender });

  const deliveredRaw = meta?.["delivered_amount"] ?? meta?.["DeliveredAmount"];
  if (deliveredRaw === undefined || deliveredRaw === "unavailable")
    unverified("delivered amount unavailable", base);
  const delivered = tryXrplAmountToMoney(deliveredRaw);
  if (!delivered) unverified("delivered amount has an unsupported shape", base);
  const expected: Money = isXrp(expect.asset)
    ? { asset: expect.asset, value: expect.amountDrops.toString() }
    : { asset: expect.asset, value: expect.amountValue ?? expect.amountDrops.toString() };
  if (!moneyEquals(delivered, expected))
    unverified("amount mismatch", { ...base, expected, actual: delivered });

  let invoiceId: string | undefined;
  if (expect.invoiceId !== undefined) {
    const memoHex = utf8ToHex(expect.invoiceId);
    const memoMatch = memoDataHex(tx).includes(memoHex);
    const fieldMatch =
      getString(tx, "InvoiceID")?.toUpperCase() === invoiceIdToInvoiceField(expect.invoiceId);
    if (!memoMatch && !fieldMatch)
      unverified("invoice id not referenced by the transaction", {
        ...base,
        invoiceId: expect.invoiceId,
      });
    invoiceId = expect.invoiceId;
  }

  const fee = getString(tx, "Fee");
  const sourceTag = getNumber(tx, "SourceTag");
  const destinationTag = getNumber(tx, "DestinationTag");
  return {
    txHash: hash,
    ledgerIndex: found.ledgerIndex,
    closeTime: found.closeTime ?? new Date(0),
    sender,
    destination,
    amount: delivered,
    feeDrops: fee && /^\d+$/.test(fee) ? BigInt(fee) : 0n,
    ...(invoiceId !== undefined ? { invoiceId } : {}),
    ...(sourceTag !== null ? { sourceTag } : {}),
    ...(destinationTag !== null ? { destinationTag } : {}),
    ledger,
  };
}

/** Verifies payments against the real ledger through the `tx` command. */
export class LedgerPaymentVerifier implements PaymentVerifier {
  readonly ledger = "testnet" as const;

  constructor(private readonly client: XrplRequestClient) {}

  /** Fetch a transaction by hash; null when the ledger does not know it (yet). */
  async getTransaction(txHash: string): Promise<LedgerTransaction | null> {
    let response: unknown;
    try {
      response = await this.client.request({ command: "tx", transaction: txHash });
    } catch (e) {
      if (rippledErrorCode(e) === "txnNotFound") return null;
      throw e;
    }
    const result = asRecord(asRecord(response)?.["result"]);
    if (!result) return null;
    return ledgerTransactionFromTxResult(result, txHash);
  }

  async verify(txHash: string, expect: PaymentExpectation): Promise<VerifiedPayment> {
    const found = await this.getTransaction(txHash);
    if (!found) unverified("transaction not found", { txHash, ledger: this.ledger });
    return verifyLedgerTransaction(found, expect, this.ledger);
  }
}
