import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { isAigentiaError, sha256Hex, utf8ToHex } from "@aigentia/shared";
import { LedgerBalanceReader } from "./balance-reader";
import { LedgerPaymentVerifier } from "./payment-verifier";
import { LedgerTransactionIndexer } from "./indexer";
import type { XrplRequestClient } from "./types";

const sender = Wallet.generate().classicAddress;
const dest = Wallet.generate().classicAddress;
const HASH = "A".repeat(64);

function rippledError(code: string): Error {
  return Object.assign(new Error(code), { data: { error: code } });
}

/** Minimal fake XRPLClient: routes each command to a handler. */
function fakeClient(
  handlers: Record<string, (cmd: Record<string, unknown>) => unknown>,
): XrplRequestClient & {
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    async request<T>(cmd: Record<string, unknown>): Promise<T> {
      calls.push(cmd);
      const handler = handlers[String(cmd["command"])];
      if (!handler) throw new Error(`unexpected command ${String(cmd["command"])}`);
      return handler(cmd) as T;
    },
  };
}

const serverInfo = {
  result: {
    info: {
      network_id: 1,
      validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2, seq: 50 },
    },
  },
};

function txResult(
  overrides: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
): unknown {
  return {
    result: {
      hash: HASH,
      ledger_index: 123,
      validated: true,
      close_time_iso: "2026-03-01T12:00:00Z",
      tx_json: {
        TransactionType: "Payment",
        Account: sender,
        Destination: dest,
        Amount: "1000",
        Fee: "12",
        Sequence: 9,
        SourceTag: 804681468,
        InvoiceID: sha256Hex("inv_1").toUpperCase(),
        Memos: [{ Memo: { MemoType: "AA", MemoData: utf8ToHex("inv_1") } }],
        ...overrides,
      },
      meta: {
        TransactionResult: "tesSUCCESS",
        delivered_amount: "1000",
        AffectedNodes: [],
        ...meta,
      },
    },
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "none";
  } catch (e) {
    return isAigentiaError(e) ? e.code : "other";
  }
}

describe("LedgerBalanceReader", () => {
  it("computes reserve from server_info and owner count", async () => {
    const client = fakeClient({
      account_info: (cmd) => {
        expect(cmd["ledger_index"]).toBe("validated");
        return { result: { account_data: { Balance: "2500000", OwnerCount: 2, Sequence: 1 } } };
      },
      server_info: () => serverInfo,
    });
    const snap = await new LedgerBalanceReader(client).getBalanceDrops(sender);
    expect(snap).toEqual({
      balanceDrops: 2_500_000n,
      reserveDrops: 1_400_000n,
      spendableDrops: 1_100_000n,
    });
  });

  it("clamps spendable at zero and returns zeros for unknown accounts", async () => {
    const low = fakeClient({
      account_info: () => ({
        result: { account_data: { Balance: "500000", OwnerCount: 0, Sequence: 1 } },
      }),
      server_info: () => serverInfo,
    });
    expect((await new LedgerBalanceReader(low).getBalanceDrops(sender)).spendableDrops).toBe(0n);
    const missing = fakeClient({
      account_info: () => {
        throw rippledError("actNotFound");
      },
    });
    expect(await new LedgerBalanceReader(missing).getBalanceDrops(sender)).toEqual({
      balanceDrops: 0n,
      reserveDrops: 0n,
      spendableDrops: 0n,
    });
    const broken = fakeClient({
      account_info: () => {
        throw rippledError("invalidParams");
      },
    });
    await expect(new LedgerBalanceReader(broken).getBalanceDrops(sender)).rejects.toThrow(
      /invalidParams/,
    );
  });
});

describe("LedgerPaymentVerifier", () => {
  const expectation = { destination: dest, amountDrops: 1000n, asset: { code: "XRP" } as const };

  it("verifies a validated tesSUCCESS payment with invoice via InvoiceID or memo", async () => {
    const verifier = new LedgerPaymentVerifier(fakeClient({ tx: () => txResult() }));
    const v = await verifier.verify(HASH, { ...expectation, sender, invoiceId: "inv_1" });
    expect(v).toMatchObject({
      txHash: HASH,
      ledgerIndex: 123,
      sender,
      destination: dest,
      feeDrops: 12n,
      invoiceId: "inv_1",
      sourceTag: 804681468,
      ledger: "testnet",
    });
    expect(v.amount).toEqual({ asset: { code: "XRP" }, value: "1000" });
    expect(v.closeTime.toISOString()).toBe("2026-03-01T12:00:00.000Z");

    const memoOnly = new LedgerPaymentVerifier(
      fakeClient({ tx: () => txResult({ InvoiceID: undefined }) }),
    );
    await expect(
      memoOnly.verify(HASH, { ...expectation, invoiceId: "inv_1" }),
    ).resolves.toBeDefined();
    const fieldOnly = new LedgerPaymentVerifier(
      fakeClient({ tx: () => txResult({ Memos: undefined }) }),
    );
    await expect(
      fieldOnly.verify(HASH, { ...expectation, invoiceId: "inv_1" }),
    ).resolves.toBeDefined();
  });

  it("fails closed on every mismatch", async () => {
    const cases: Array<[string, unknown, Record<string, unknown>?]> = [
      [
        "not validated",
        {
          result: {
            ...(txResult() as { result: Record<string, unknown> }).result,
            validated: false,
          },
        },
      ],
      ["not a payment", txResult({ TransactionType: "OfferCreate" })],
      ["tec result", txResult({}, { TransactionResult: "tecPATH_DRY" })],
      ["wrong destination", txResult({ Destination: sender })],
      ["wrong amount", txResult({}, { delivered_amount: "999" })],
      ["delivered unavailable", txResult({}, { delivered_amount: "unavailable" })],
      [
        "issued instead of XRP",
        txResult({}, { delivered_amount: { currency: "USD", issuer: sender, value: "1" } }),
      ],
      ["wrong sender", txResult(), { sender: dest }],
      ["wrong invoice", txResult(), { invoiceId: "inv_2" }],
    ];
    for (const [label, response, extra] of cases) {
      const verifier = new LedgerPaymentVerifier(fakeClient({ tx: () => response }));
      expect(await codeOf(verifier.verify(HASH, { ...expectation, ...extra })), label).toBe(
        "PAYMENT_UNVERIFIED",
      );
    }
    const missing = new LedgerPaymentVerifier(
      fakeClient({
        tx: () => {
          throw rippledError("txnNotFound");
        },
      }),
    );
    expect(await missing.getTransaction(HASH)).toBeNull();
    expect(await codeOf(missing.verify(HASH, expectation))).toBe("PAYMENT_UNVERIFIED");
  });

  it("verifies issued-currency deliveries against the expected asset", async () => {
    const rlusdHex = "524C555344000000000000000000000000000000";
    const verifier = new LedgerPaymentVerifier(
      fakeClient({
        tx: () =>
          txResult(
            { Amount: { currency: rlusdHex, issuer: sender, value: "2.5" } },
            { delivered_amount: { currency: rlusdHex, issuer: sender, value: "2.5" } },
          ),
      }),
    );
    const v = await verifier.verify(HASH, {
      destination: dest,
      amountDrops: 0n,
      amountValue: "2.5",
      asset: { code: "RLUSD", issuer: sender, currencyHex: rlusdHex },
    });
    expect(v.amount.value).toBe("2.5");
    expect(
      await codeOf(
        verifier.verify(HASH, {
          destination: dest,
          amountDrops: 0n,
          amountValue: "2.5",
          asset: { code: "RLUSD", issuer: dest, currencyHex: rlusdHex },
        }),
      ),
    ).toBe("PAYMENT_UNVERIFIED");
  });
});

describe("LedgerTransactionIndexer", () => {
  it("paginates account_tx with markers and normalises records", async () => {
    const entry = (
      hash: string,
      ledgerIndex: number,
      extra: Record<string, unknown> = {},
    ): unknown => ({
      hash,
      ledger_index: ledgerIndex,
      validated: true,
      close_time_iso: "2026-03-01T12:00:00Z",
      tx_json: {
        TransactionType: "Payment",
        Account: sender,
        Destination: dest,
        Amount: "1000",
        Fee: "12",
        Memos: [{ Memo: { MemoData: utf8ToHex("note") } }],
        InvoiceID: "B".repeat(64),
        ...extra,
      },
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000" },
    });
    const client = fakeClient({
      account_tx: (cmd) => {
        expect(cmd["forward"]).toBe(true);
        expect(cmd["ledger_index_min"]).toBe(10);
        if (cmd["marker"] === undefined) {
          return {
            result: { transactions: [entry("1".repeat(64), 11)], marker: { ledger: 11, seq: 1 } },
          };
        }
        return {
          result: {
            transactions: [
              entry("2".repeat(64), 12, {
                TransactionType: "AccountSet",
                Destination: undefined,
                Amount: undefined,
              }),
              { tx_json: { TransactionType: "Payment" } },
            ],
          },
        };
      },
    });
    const records = await new LedgerTransactionIndexer(client).indexAddress(sender, {
      sinceLedger: 10,
    });
    expect(client.calls).toHaveLength(2);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      txHash: "1".repeat(64),
      ledgerIndex: 11,
      transactionType: "Payment",
      sender,
      receiver: dest,
      amountDrops: 1000n,
      feeDrops: 12n,
      result: "tesSUCCESS",
      validated: true,
      memo: "note",
      invoiceIdHash: "B".repeat(64),
      ledger: "testnet",
    });
    expect(records[0]?.closeTime?.toISOString()).toBe("2026-03-01T12:00:00.000Z");
    expect(records[1]).toMatchObject({
      transactionType: "AccountSet",
      receiver: null,
      amountDrops: null,
    });
    expect(JSON.stringify(records[0]?.raw)).toContain("tesSUCCESS");

    const limited = await new LedgerTransactionIndexer(client).indexAddress(sender, {
      sinceLedger: 10,
      limit: 1,
    });
    expect(limited).toHaveLength(1);
  });
});
