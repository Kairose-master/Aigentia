import { describe, expect, it } from "vitest";
import { isAigentiaError, xrp } from "@aigentia/shared";
import { sendPayment } from "../payment";
import { MockLedger } from "./mock-ledger";
import { MockWalletProvider } from "./mock-wallet-provider";

async function runScenario(): Promise<{
  ledger: MockLedger;
  wallets: MockWalletProvider;
  hash: string;
  buyer: string;
  seller: string;
}> {
  const ledger = new MockLedger();
  const wallets = new MockWalletProvider("scenario-salt");
  const buyer = await wallets.getAddress("buyer");
  const seller = await wallets.getAddress("seller");
  ledger.fund(buyer, 10_000_000n);
  ledger.fund(seller, 10_000_000n);
  const submitted = await sendPayment(ledger, wallets, "buyer", {
    destination: seller,
    amount: xrp(250_000),
    invoiceId: "inv_scenario",
  });
  return { ledger, wallets, hash: submitted.hash, buyer, seller };
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "none";
  } catch (e) {
    return isAigentiaError(e) ? `${e.code}:${String(e.details?.["result"] ?? "")}` : "other";
  }
}

describe("MockLedger", () => {
  it("fund → pay → verify round trip labels everything as mock", async () => {
    const { ledger, hash, buyer, seller } = await runScenario();
    expect(hash).toMatch(/^[0-9A-F]{64}$/);
    const verified = await ledger.verify(hash, {
      destination: seller,
      amountDrops: 250_000n,
      asset: { code: "XRP" },
      sender: buyer,
      invoiceId: "inv_scenario",
    });
    expect(verified.ledger).toBe("mock");
    expect(verified.sender).toBe(buyer);
    expect(verified.destination).toBe(seller);
    expect(verified.amount).toEqual(xrp(250_000));
    expect(verified.feeDrops).toBe(12n);
    expect(verified.invoiceId).toBe("inv_scenario");
    expect(verified.closeTime).toBeInstanceOf(Date);

    const buyerBal = await ledger.getBalanceDrops(buyer);
    expect(buyerBal.balanceDrops).toBe(10_000_000n - 250_000n - 12n);
    expect(buyerBal.reserveDrops).toBe(1_000_000n);
    expect(buyerBal.spendableDrops).toBe(buyerBal.balanceDrops - 1_000_000n);
    expect((await ledger.getBalanceDrops(seller)).balanceDrops).toBe(10_250_000n);
    expect(await ledger.getBalanceDrops("rrrrrrrrrrrrrrrrrrrrBZbvji")).toEqual({
      balanceDrops: 0n,
      reserveDrops: 0n,
      spendableDrops: 0n,
    });

    const records = await ledger.indexAddress(seller);
    expect(records.map((r) => r.ledger)).toEqual(["mock", "mock"]);
    const payment = records.find((r) => r.txHash === hash);
    expect(payment?.memo).toBe("inv_scenario");
    expect(payment?.amountDrops).toBe(250_000n);
    expect(payment?.sender).toBe(buyer);
    expect(payment?.invoiceIdHash).toMatch(/^[0-9A-F]{64}$/);
    expect(await ledger.indexAddress(seller, { sinceLedger: payment?.ledgerIndex })).toHaveLength(
      1,
    );
    expect(await ledger.indexAddress(seller, { limit: 1 })).toHaveLength(1);
  });

  it("is deterministic across two identical runs", async () => {
    const a = await runScenario();
    const b = await runScenario();
    expect(a.hash).toBe(b.hash);
    expect(a.buyer).toBe(b.buyer);
    expect(a.ledger.snapshot()).toEqual(b.ledger.snapshot());
    expect(JSON.parse(JSON.stringify(a.ledger.snapshot()))).toEqual(a.ledger.snapshot());
  });

  it("fails verification on wrong destination, amount, sender or invoice", async () => {
    const { ledger, hash, buyer, seller } = await runScenario();
    const ok = { destination: seller, amountDrops: 250_000n, asset: { code: "XRP" } as const };
    expect(await errorCode(ledger.verify(hash, { ...ok, destination: buyer }))).toMatch(
      /^PAYMENT_UNVERIFIED/,
    );
    expect(await errorCode(ledger.verify(hash, { ...ok, amountDrops: 250_001n }))).toMatch(
      /^PAYMENT_UNVERIFIED/,
    );
    expect(await errorCode(ledger.verify(hash, { ...ok, sender: seller }))).toMatch(
      /^PAYMENT_UNVERIFIED/,
    );
    expect(await errorCode(ledger.verify(hash, { ...ok, invoiceId: "inv_other" }))).toMatch(
      /^PAYMENT_UNVERIFIED/,
    );
    expect(await errorCode(ledger.verify("0".repeat(64), ok))).toMatch(/^PAYMENT_UNVERIFIED/);
    expect(
      await errorCode(
        ledger.verify(hash, {
          ...ok,
          asset: {
            code: "RLUSD",
            issuer: seller,
            currencyHex: "524C555344000000000000000000000000000000",
          },
          amountValue: "1",
        }),
      ),
    ).toMatch(/^PAYMENT_UNVERIFIED/);
    await expect(ledger.verify(hash, ok)).resolves.toMatchObject({ txHash: hash });
  });

  it("rejects unfunded, replayed, unknown-account and dust-creating payments with result codes", async () => {
    const ledger = new MockLedger();
    const wallets = new MockWalletProvider("failure-salt");
    const rich = await wallets.getAddress("rich");
    const poor = await wallets.getAddress("poor");
    const fresh = await wallets.getAddress("fresh");
    ledger.fund(rich, 5_000_000n);

    expect(
      await errorCode(sendPayment(ledger, wallets, "poor", { destination: rich, amount: xrp(1) })),
    ).toBe("NOT_FOUND:");
    expect(
      await errorCode(
        sendPayment(ledger, wallets, "rich", { destination: poor, amount: xrp(4_500_000) }),
      ),
    ).toBe("PAYMENT_FAILED:tecUNFUNDED_PAYMENT");
    expect(
      await errorCode(sendPayment(ledger, wallets, "rich", { destination: fresh, amount: xrp(1) })),
    ).toBe("PAYMENT_FAILED:tecNO_DST_INSUF_XRP");
    expect((await ledger.getBalanceDrops(rich)).balanceDrops).toBe(5_000_000n);

    const filled = await ledger.autofill({
      TransactionType: "Payment",
      Account: rich,
      Destination: fresh,
      Amount: "1000000",
    });
    const { txBlob } = await wallets.sign("rich", filled);
    const first = ledger.submitSigned(txBlob);
    expect(first.result).toBe("tesSUCCESS");
    expect(first.ledger).toBe("mock");
    expect(await errorCode(ledger.submitAndWait(txBlob))).toBe("PAYMENT_FAILED:tefALREADY");
    expect(await errorCode(ledger.submitAndWait("DEADBEEF"))).toMatch(/^PAYMENT_FAILED:tem/);
    // Stale sequence after the first payment consumed it.
    const stale = await wallets.sign("rich", { ...filled, Amount: "1000" });
    expect(await errorCode(ledger.submitAndWait(stale.txBlob))).toBe("PAYMENT_FAILED:tefPAST_SEQ");
    expect(ledger.ledgerIndex).toBe(1002);
  });

  it("MockWalletProvider derives the same address for the same salt and applies the signer policy", async () => {
    const a = new MockWalletProvider("s");
    const b = new MockWalletProvider("s");
    const c = new MockWalletProvider("t");
    expect(await a.getAddress("x")).toBe(await b.getAddress("x"));
    expect(await a.getAddress("x")).not.toBe(await c.getAddress("x"));
    expect(await a.ensureWallet("y")).toMatchObject({ created: true });
    expect(await a.ensureWallet("y")).toMatchObject({ created: false });
    await expect(
      a.sign("x", {
        TransactionType: "Payment",
        Account: await c.getAddress("x"),
        Destination: await a.getAddress("y"),
        Amount: "1",
        Fee: "12",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
