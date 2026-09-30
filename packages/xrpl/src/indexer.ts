import { isXrp } from "@aigentia/shared";
import { tryXrplAmountToMoney } from "./asset";
import {
  asRecord,
  firstMemoText,
  getString,
  ledgerTransactionFromAccountTxEntry,
  toPlainJson,
} from "./internal/tx-parse";
import type {
  IndexAddressOptions,
  LedgerKind,
  LedgerTransaction,
  LedgerTxRecord,
  TransactionIndexer,
  XrplRequestClient,
} from "./types";

const PAGE_LIMIT = 200;

/** Normalise a fetched transaction into the flat record stored in `ledger_transactions`. */
export function ledgerTxRecordFrom(found: LedgerTransaction, ledger: LedgerKind): LedgerTxRecord {
  const { tx, meta } = found;
  const transactionType = getString(tx, "TransactionType") ?? "unknown";
  const deliveredRaw =
    transactionType === "Payment"
      ? (meta?.["delivered_amount"] ?? meta?.["DeliveredAmount"] ?? tx["Amount"])
      : undefined;
  const delivered = tryXrplAmountToMoney(deliveredRaw);
  const fee = getString(tx, "Fee");
  return {
    txHash: found.hash,
    ledgerIndex: found.ledgerIndex ?? 0,
    closeTime: found.closeTime,
    transactionType,
    sender: getString(tx, "Account") ?? "",
    receiver: getString(tx, "Destination"),
    amountDrops: delivered && isXrp(delivered.asset) ? BigInt(delivered.value) : null,
    feeDrops: fee && /^\d+$/.test(fee) ? BigInt(fee) : null,
    result: getString(meta, "TransactionResult") ?? "unknown",
    validated: found.validated,
    memo: firstMemoText(tx),
    invoiceIdHash: getString(tx, "InvoiceID"),
    raw: toPlainJson({ tx, meta, hash: found.hash, ledger_index: found.ledgerIndex }),
    ledger,
  };
}

/** Walks `account_tx` (oldest first) with marker pagination. */
export class LedgerTransactionIndexer implements TransactionIndexer {
  readonly ledger = "testnet" as const;

  constructor(private readonly client: XrplRequestClient) {}

  async indexAddress(
    address: string,
    options: IndexAddressOptions = {},
  ): Promise<LedgerTxRecord[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const records: LedgerTxRecord[] = [];
    let marker: unknown = undefined;
    while (records.length < limit) {
      const page = await this.client.request<unknown>({
        command: "account_tx",
        account: address,
        ledger_index_min: options.sinceLedger ?? -1,
        ledger_index_max: -1,
        forward: true,
        limit: Math.min(
          PAGE_LIMIT,
          limit === Number.POSITIVE_INFINITY ? PAGE_LIMIT : limit - records.length,
        ),
        ...(marker !== undefined ? { marker } : {}),
      });
      const result = asRecord(asRecord(page)?.["result"]);
      const transactions = result?.["transactions"];
      if (!Array.isArray(transactions)) break;
      for (const entry of transactions) {
        const rec = asRecord(entry);
        const found = rec ? ledgerTransactionFromAccountTxEntry(rec) : null;
        if (!found) continue;
        records.push(ledgerTxRecordFrom(found, this.ledger));
        if (records.length >= limit) break;
      }
      marker = result?.["marker"];
      if (marker === undefined || marker === null || transactions.length === 0) break;
    }
    return records;
  }
}
