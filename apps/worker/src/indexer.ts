import { ledgerTransactions, payments, type Database } from "@aigentia/db";
import type { WorldStore } from "@aigentia/game-engine";
import { errorMessage, type Logger } from "@aigentia/shared";
import type { LedgerTxRecord, TransactionIndexer } from "@aigentia/xrpl";
import { inArray, sql } from "drizzle-orm";

export interface LedgerIndexDeps {
  readonly db: Database;
  readonly store: Pick<WorldStore, "listAgents">;
  readonly indexer: TransactionIndexer;
  /** Extra addresses to track besides every agent's wallet (e.g. the treasury). */
  readonly extraAddresses?: readonly string[];
  readonly logger?: Logger;
  /** Max transactions fetched per address per run. */
  readonly limit?: number;
}

export interface LedgerIndexResult {
  readonly addresses: number;
  readonly fetched: number;
  readonly inserted: number;
  readonly failedAddresses: string[];
}

type LedgerTxRow = typeof ledgerTransactions.$inferInsert;

/** Pure: a LedgerTxRecord as a `ledger_transactions` row (paymentId linked separately). */
export function ledgerTxRow(record: LedgerTxRecord, paymentId: string | null): LedgerTxRow {
  return {
    txHash: record.txHash,
    ledger: record.ledger,
    transactionType: record.transactionType,
    senderAddress: record.sender,
    receiverAddress: record.receiver,
    asset: "XRP",
    amountDrops: record.amountDrops,
    feeDrops: record.feeDrops,
    ledgerIndex: record.ledgerIndex,
    closeTime: record.closeTime,
    invoiceId: record.invoiceIdHash,
    memo: record.memo,
    result: record.result,
    validated: record.validated,
    paymentId,
    raw: record.raw,
  };
}

/**
 * Index on-ledger activity for every tracked address into `ledger_transactions`, linking each
 * row to the game payment that shares its tx hash. Idempotent: existing hashes are left as is.
 */
export async function indexLedger(deps: LedgerIndexDeps): Promise<LedgerIndexResult> {
  const agents = await deps.store.listAgents();
  const addresses = new Set<string>([
    ...agents.map((a) => a.walletAddress),
    ...(deps.extraAddresses ?? []),
  ]);
  addresses.delete("");
  const byHash = new Map<string, LedgerTxRecord>();
  const failedAddresses: string[] = [];
  for (const address of addresses) {
    try {
      const records = await deps.indexer.indexAddress(address, { limit: deps.limit ?? 200 });
      for (const r of records) byHash.set(r.txHash, r);
    } catch (e) {
      failedAddresses.push(address);
      deps.logger?.warn({ address, error: errorMessage(e) }, "ledger index failed for address");
    }
  }
  if (byHash.size === 0) {
    return { addresses: addresses.size, fetched: 0, inserted: 0, failedAddresses };
  }
  const hashes = [...byHash.keys()];
  const known = new Set(
    (
      await deps.db
        .select({ txHash: ledgerTransactions.txHash })
        .from(ledgerTransactions)
        .where(inArray(ledgerTransactions.txHash, hashes))
    ).map((r) => r.txHash),
  );
  const fresh = hashes.filter((h) => !known.has(h));
  if (fresh.length === 0) {
    await relinkPayments(deps.db);
    return { addresses: addresses.size, fetched: hashes.length, inserted: 0, failedAddresses };
  }
  const paymentByHash = new Map<string, string>();
  for (const p of await deps.db
    .select({ id: payments.id, txHash: payments.txHash })
    .from(payments)
    .where(inArray(payments.txHash, fresh))) {
    if (p.txHash) paymentByHash.set(p.txHash, p.id);
  }
  const rows: LedgerTxRow[] = [];
  for (const hash of fresh) {
    const record = byHash.get(hash);
    if (record) rows.push(ledgerTxRow(record, paymentByHash.get(hash) ?? null));
  }
  const inserted = await deps.db
    .insert(ledgerTransactions)
    .values(rows)
    .onConflictDoNothing()
    .returning({ txHash: ledgerTransactions.txHash });
  await relinkPayments(deps.db);
  deps.logger?.info(
    { addresses: addresses.size, fetched: hashes.length, inserted: inserted.length },
    "ledger indexed",
  );
  return {
    addresses: addresses.size,
    fetched: hashes.length,
    inserted: inserted.length,
    failedAddresses,
  };
}

/**
 * Link ledger rows that were indexed before the game recorded the payment carrying the same
 * hash (e.g. a payment still being written when the indexer ran). Idempotent.
 */
export async function relinkPayments(db: Database): Promise<void> {
  await db.execute(sql`
    UPDATE ${ledgerTransactions} AS lt
       SET payment_id = p.id
      FROM ${payments} AS p
     WHERE lt.payment_id IS NULL
       AND p.tx_hash = lt.tx_hash`);
}
