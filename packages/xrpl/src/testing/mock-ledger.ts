import { AigentiaError, sha256Hex } from "@aigentia/shared";
import { decode, hashes, isValidClassicAddress, verifySignature } from "xrpl";
import { ledgerTxRecordFrom } from "../indexer";
import { getNumber, getString } from "../internal/tx-parse";
import { verifyLedgerTransaction } from "../payment-verifier";
import type {
  BalanceReader,
  BalanceSnapshot,
  IndexAddressOptions,
  LedgerTransaction,
  LedgerTxRecord,
  PaymentExpectation,
  PaymentVerifier,
  SubmitResult,
  TransactionIndexer,
  TransactionSubmitter,
  VerifiedPayment,
} from "../types";

/** Sender recorded for faucet-style funding on the mock ledger (XRPL's ACCOUNT_ZERO). */
export const MOCK_FAUCET_ADDRESS = "rrrrrrrrrrrrrrrrrrrrrhoLvTp";

export interface MockLedgerOptions {
  readonly reserveBaseDrops?: bigint;
  readonly reserveIncDrops?: bigint;
  readonly feeDrops?: bigint;
  readonly startLedgerIndex?: number;
}

interface MockAccount {
  balance: bigint;
  sequence: number;
  ownerCount: number;
}

interface MockTx {
  hash: string;
  ledgerIndex: number;
  tx: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface MockLedgerSnapshot {
  readonly ledger: "mock";
  readonly ledgerIndex: number;
  readonly accounts: Array<{ address: string; balanceDrops: string; sequence: number }>;
  readonly transactions: Array<{
    hash: string;
    ledgerIndex: number;
    sender: string;
    destination: string | null;
    amountDrops: string | null;
    result: string;
  }>;
}

function fail(result: string, details: Record<string, unknown> = {}): never {
  throw new AigentiaError("PAYMENT_FAILED", `mock ledger rejected transaction: ${result}`, {
    result,
    ledger: "mock",
    ...details,
  });
}

/** Deterministic close time: one ledger per 4 seconds from a fixed epoch. */
function mockCloseTime(ledgerIndex: number): Date {
  return new Date(Date.UTC(2026, 0, 1) + ledgerIndex * 4_000);
}

/**
 * [MOCK] In-process XRPL stand-in for tests and SIM_LEDGER=mock. Real signing, real blob decoding,
 * real signature checks and real transaction hashes (hashSignedTx); balances, sequences and
 * ledger indexes are simulated deterministically. Everything it produces says ledger: "mock".
 */
export class MockLedger
  implements BalanceReader, PaymentVerifier, TransactionIndexer, TransactionSubmitter
{
  readonly ledger = "mock" as const;
  private readonly accounts = new Map<string, MockAccount>();
  private readonly txs = new Map<string, MockTx>();
  private readonly order: string[] = [];
  private currentLedger: number;
  private readonly reserveBaseDrops: bigint;
  private readonly reserveIncDrops: bigint;
  private readonly feeDrops: bigint;

  constructor(options: MockLedgerOptions = {}) {
    console.warn("[MOCK] MockLedger: in-process ledger, never for production");
    this.reserveBaseDrops = options.reserveBaseDrops ?? 1_000_000n;
    this.reserveIncDrops = options.reserveIncDrops ?? 200_000n;
    this.feeDrops = options.feeDrops ?? 12n;
    this.currentLedger = options.startLedgerIndex ?? 1_000;
  }

  get ledgerIndex(): number {
    return this.currentLedger;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  private closeLedger(): number {
    this.currentLedger += 1;
    return this.currentLedger;
  }

  private record(entry: MockTx): void {
    this.txs.set(entry.hash, entry);
    this.order.push(entry.hash);
  }

  private reserveFor(account: MockAccount): bigint {
    return this.reserveBaseDrops + this.reserveIncDrops * BigInt(account.ownerCount);
  }

  /** Faucet-style funding: creates the account when needed. Recorded as a Payment from the mock faucet. */
  fund(address: string, drops: bigint): { hash: string; ledgerIndex: number; ledger: "mock" } {
    if (!isValidClassicAddress(address)) {
      throw new AigentiaError("VALIDATION_FAILED", "invalid XRPL address", { address });
    }
    if (drops <= 0n) throw new AigentiaError("VALIDATION_FAILED", "funding must be positive");
    const ledgerIndex = this.closeLedger();
    const existing = this.accounts.get(address);
    if (existing) existing.balance += drops;
    else this.accounts.set(address, { balance: drops, sequence: ledgerIndex, ownerCount: 0 });
    const hash = sha256Hex(`mock-fund|${address}|${drops}|${ledgerIndex}`).toUpperCase();
    this.record({
      hash,
      ledgerIndex,
      tx: {
        TransactionType: "Payment",
        Account: MOCK_FAUCET_ADDRESS,
        Destination: address,
        Amount: drops.toString(),
        Fee: "0",
        Sequence: ledgerIndex,
      },
      meta: {
        TransactionResult: "tesSUCCESS",
        delivered_amount: drops.toString(),
        AffectedNodes: [],
      },
    });
    return { hash, ledgerIndex, ledger: "mock" };
  }

  async autofill(tx: Record<string, unknown>): Promise<Record<string, unknown>> {
    const account = getString(tx, "Account");
    const state = account ? this.accounts.get(account) : undefined;
    if (!account || !state) {
      throw new AigentiaError("NOT_FOUND", "account not found on the mock ledger", { account });
    }
    return {
      ...tx,
      Sequence: tx["Sequence"] ?? state.sequence,
      Fee: tx["Fee"] ?? this.feeDrops.toString(),
      LastLedgerSequence: tx["LastLedgerSequence"] ?? this.currentLedger + 20,
    };
  }

  /** Decode, verify and apply a signed blob. tec/tem/tef/ter failures throw PAYMENT_FAILED with the code. */
  submitSigned(txBlob: string): SubmitResult {
    let tx: Record<string, unknown>;
    try {
      tx = decode(txBlob);
    } catch {
      return fail("temMALFORMED", { reason: "undecodable blob" });
    }
    let signatureOk = false;
    try {
      signatureOk = verifySignature(txBlob);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) fail("temBAD_SIGNATURE");
    const hash = hashes.hashSignedTx(txBlob);
    if (this.txs.has(hash)) fail("tefALREADY", { hash });
    if (tx["TransactionType"] !== "Payment")
      fail("temMALFORMED", { reason: "only Payment supported" });

    const account = getString(tx, "Account");
    const sender = account ? this.accounts.get(account) : undefined;
    if (!account || !sender) fail("terNO_ACCOUNT", { account });

    const sequence = getNumber(tx, "Sequence");
    if (sequence === null || sequence < sender.sequence)
      fail("tefPAST_SEQ", { sequence, expected: sender.sequence });
    if (sequence > sender.sequence) fail("terPRE_SEQ", { sequence, expected: sender.sequence });

    const lastLedger = getNumber(tx, "LastLedgerSequence");
    if (lastLedger !== null && lastLedger <= this.currentLedger)
      fail("tefMAX_LEDGER", { lastLedger });

    const feeRaw = getString(tx, "Fee");
    if (!feeRaw || !/^\d+$/.test(feeRaw)) fail("temBAD_FEE");
    const fee = BigInt(feeRaw);

    const amountRaw = tx["Amount"];
    if (typeof amountRaw !== "string" || !/^[1-9]\d*$/.test(amountRaw))
      fail("temBAD_AMOUNT", { reason: "mock ledger settles XRP drops only" });
    const amount = BigInt(amountRaw);

    const destination = getString(tx, "Destination");
    if (!destination || !isValidClassicAddress(destination)) fail("temDST_NEEDED");
    if (destination === account) fail("temREDUNDANT");

    if (sender.balance < fee) fail("terINSUF_FEE_B", { balance: sender.balance.toString() });
    if (sender.balance - fee - amount < this.reserveFor(sender))
      fail("tecUNFUNDED_PAYMENT", {
        balance: sender.balance.toString(),
        reserve: this.reserveFor(sender).toString(),
        amount: amount.toString(),
      });
    const receiver = this.accounts.get(destination);
    if (!receiver && amount < this.reserveBaseDrops)
      fail("tecNO_DST_INSUF_XRP", {
        amount: amount.toString(),
        reserve: this.reserveBaseDrops.toString(),
      });

    // Apply.
    const ledgerIndex = this.closeLedger();
    sender.balance -= fee + amount;
    sender.sequence += 1;
    if (receiver) receiver.balance += amount;
    else this.accounts.set(destination, { balance: amount, sequence: ledgerIndex, ownerCount: 0 });
    const meta: Record<string, unknown> = {
      TransactionResult: "tesSUCCESS",
      delivered_amount: amount.toString(),
      TransactionIndex: 0,
      AffectedNodes: [],
    };
    this.record({ hash, ledgerIndex, tx, meta });
    return {
      hash,
      ledgerIndex,
      result: "tesSUCCESS",
      validated: true,
      deliveredDrops: amount,
      meta,
      ledger: "mock",
    };
  }

  async submitAndWait(txBlob: string): Promise<SubmitResult> {
    return this.submitSigned(txBlob);
  }

  private toLedgerTransaction(entry: MockTx): LedgerTransaction {
    return {
      hash: entry.hash,
      ledgerIndex: entry.ledgerIndex,
      validated: true,
      closeTime: mockCloseTime(entry.ledgerIndex),
      tx: entry.tx,
      meta: entry.meta,
    };
  }

  async getTransaction(txHash: string): Promise<LedgerTransaction | null> {
    const entry = this.txs.get(txHash.toUpperCase());
    return entry ? this.toLedgerTransaction(entry) : null;
  }

  async verify(txHash: string, expect: PaymentExpectation): Promise<VerifiedPayment> {
    const found = await this.getTransaction(txHash);
    if (!found) {
      throw new AigentiaError("PAYMENT_UNVERIFIED", "transaction not found", {
        txHash,
        ledger: "mock",
      });
    }
    return verifyLedgerTransaction(found, expect, "mock");
  }

  async getBalanceDrops(address: string): Promise<BalanceSnapshot> {
    const account = this.accounts.get(address);
    if (!account) return { balanceDrops: 0n, reserveDrops: 0n, spendableDrops: 0n };
    const reserveDrops = this.reserveFor(account);
    const spendable = account.balance - reserveDrops;
    return {
      balanceDrops: account.balance,
      reserveDrops,
      spendableDrops: spendable > 0n ? spendable : 0n,
    };
  }

  async indexAddress(
    address: string,
    options: IndexAddressOptions = {},
  ): Promise<LedgerTxRecord[]> {
    const out: LedgerTxRecord[] = [];
    for (const hash of this.order) {
      const entry = this.txs.get(hash);
      if (!entry) continue;
      if (options.sinceLedger !== undefined && entry.ledgerIndex < options.sinceLedger) continue;
      if (entry.tx["Account"] !== address && entry.tx["Destination"] !== address) continue;
      out.push(ledgerTxRecordFrom(this.toLedgerTransaction(entry), "mock"));
      if (options.limit !== undefined && out.length >= options.limit) break;
    }
    return out;
  }

  /** Serialisable state, for determinism assertions across runs. */
  snapshot(): MockLedgerSnapshot {
    return {
      ledger: "mock",
      ledgerIndex: this.currentLedger,
      accounts: [...this.accounts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([address, a]) => ({
          address,
          balanceDrops: a.balance.toString(),
          sequence: a.sequence,
        })),
      transactions: this.order.map((hash) => {
        const entry = this.txs.get(hash);
        const tx = entry?.tx ?? {};
        return {
          hash,
          ledgerIndex: entry?.ledgerIndex ?? 0,
          sender: getString(tx, "Account") ?? "",
          destination: getString(tx, "Destination"),
          amountDrops: typeof tx["Amount"] === "string" ? tx["Amount"] : null,
          result: getString(entry?.meta ?? null, "TransactionResult") ?? "unknown",
        };
      }),
    };
  }
}
