import { describe, expect, it, vi } from "vitest";
import { isAigentiaError } from "@aigentia/shared";
import { budgetPolicySchema } from "@aigentia/protocol";
import { MockLedger, MockWalletProvider } from "@aigentia/xrpl/testing";
import { createPaymentIntent } from "../intent";
import { PolicyEngine } from "../policy-engine";
import { InMemorySpendTracker, spentInWindows } from "../spend-tracker";
import { MockPaymentAdapter } from "./mock-payment-adapter";

async function setup(): Promise<{
  ledger: MockLedger;
  wallets: MockWalletProvider;
  adapter: MockPaymentAdapter;
  buyer: string;
  seller: string;
}> {
  const ledger = new MockLedger();
  const wallets = new MockWalletProvider("economy-tests");
  const buyer = await wallets.getAddress("buyer");
  const seller = await wallets.getAddress("seller");
  ledger.fund(buyer, 10_000_000n);
  ledger.fund(seller, 5_000_000n);
  return { ledger, wallets, adapter: new MockPaymentAdapter(ledger, wallets), buyer, seller };
}

describe("MockPaymentAdapter", () => {
  it("logs a [MOCK] warning on construction and labels itself mock", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { adapter } = await setup();
      expect(adapter.ledger).toBe("mock");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("[MOCK] MockPaymentAdapter"))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("executes an approved intent: the receipt verifies on the ledger and balances move", async () => {
    const { ledger, adapter, buyer, seller } = await setup();
    const policy = budgetPolicySchema.parse({
      maxSpendPerActionDrops: "500000",
      maxSpendPerHourDrops: "3000000",
      maxDailySpendDrops: "8000000",
      minimumBalanceDrops: "1500000",
    });
    const now = new Date("2026-05-01T12:00:00.000Z");
    const tracker = new InMemorySpendTracker();
    const intent = createPaymentIntent({
      id: "pin_mock0000001",
      agentId: "agt_buyer00001",
      purpose: "x402",
      destinationAddress: seller,
      destinationAgentId: "agt_seller0001",
      amount: 250_000n,
      serviceCategory: "intelligence",
      actionRef: { kind: "invocation", id: "inv_1" },
      createdAt: now.toISOString(),
    });

    const balance = await ledger.getBalanceDrops(buyer);
    const decision = new PolicyEngine().evaluate(intent, {
      policy,
      balanceDrops: balance.balanceDrops,
      reserveDrops: balance.reserveDrops,
      ...(await spentInWindows(tracker, intent.agentId, now)),
      ownAddress: buyer,
      now,
    });
    expect(decision.approved).toBe(true);

    const receipt = await adapter.execute(intent, {
      walletRef: "buyer",
      tick: 1,
      invoiceId: "inv_1",
      memo: "scout",
    });
    await tracker.record(intent.agentId, 250_000n, now);

    expect(receipt.ledger).toBe("mock");
    expect(receipt.intentId).toBe(intent.id);
    expect(receipt.paymentId).toMatch(/^pay_[0-9a-z]{16}$/);
    expect(receipt.txHash).toMatch(/^[0-9A-F]{64}$/);
    expect(receipt.senderAddress).toBe(buyer);
    expect(receipt.receiverAddress).toBe(seller);
    expect(receipt.amount).toBe("250000");
    expect(receipt.invoiceId).toBe("inv_1");
    expect(receipt.ledgerIndex).toBeGreaterThan(0);

    const verified = await ledger.verify(receipt.txHash, {
      destination: seller,
      amountDrops: 250_000n,
      asset: { code: "XRP" },
      sender: buyer,
      invoiceId: "inv_1",
    });
    expect(verified.txHash).toBe(receipt.txHash);
    expect(verified.ledger).toBe("mock");
    expect(verified.ledgerIndex).toBe(receipt.ledgerIndex);
    expect(new Date(receipt.validatedAt).getTime()).toBe(verified.closeTime.getTime());

    expect((await ledger.getBalanceDrops(buyer)).balanceDrops).toBe(10_000_000n - 250_000n - 12n);
    expect((await ledger.getBalanceDrops(seller)).balanceDrops).toBe(5_250_000n);
    expect(await tracker.spentSince(intent.agentId, new Date(0))).toBe(250_000n);

    const indexed = await ledger.indexAddress(seller);
    const record = indexed.find((r) => r.txHash === receipt.txHash);
    expect(record?.memo).toBe("inv_1");
    expect(record?.ledger).toBe("mock");
  });

  it("fails closed with PAYMENT_FAILED when the ledger rejects the payment", async () => {
    const { ledger, adapter, buyer, seller } = await setup();
    const intent = createPaymentIntent({
      agentId: "agt_buyer00001",
      purpose: "transfer",
      destinationAddress: seller,
      amount: 9_999_000n,
      actionRef: { kind: "decision", id: "dec_1" },
    });
    let code = "none";
    let result: unknown;
    try {
      await adapter.execute(intent, { walletRef: "buyer", tick: 2 });
    } catch (e) {
      if (isAigentiaError(e)) {
        code = e.code;
        result = e.details?.["result"];
      }
    }
    expect(code).toBe("PAYMENT_FAILED");
    expect(result).toBe("tecUNFUNDED_PAYMENT");
    expect((await ledger.getBalanceDrops(buyer)).balanceDrops).toBe(10_000_000n);
    expect((await ledger.getBalanceDrops(seller)).balanceDrops).toBe(5_000_000n);
  });

  it("refuses to pay from an unknown wallet on the ledger", async () => {
    const { adapter, seller } = await setup();
    const intent = createPaymentIntent({
      agentId: "agt_ghost00001",
      purpose: "transfer",
      destinationAddress: seller,
      amount: 1_000n,
      actionRef: { kind: "decision", id: "dec_2" },
    });
    await expect(adapter.execute(intent, { walletRef: "ghost", tick: 2 })).rejects.toMatchObject({
      code: "PAYMENT_FAILED",
      details: { cause: "NOT_FOUND" },
    });
  });

  it("is deterministic across runs with the same salt", async () => {
    const run = async (): Promise<string> => {
      const { adapter, seller } = await setup();
      const intent = createPaymentIntent({
        id: "pin_determin001",
        createdAt: "2026-01-01T00:00:00.000Z",
        agentId: "agt_buyer00001",
        purpose: "transfer",
        destinationAddress: seller,
        amount: 42_000n,
        actionRef: { kind: "decision", id: "dec_3" },
      });
      const receipt = await adapter.execute(intent, {
        walletRef: "buyer",
        tick: 1,
        paymentId: "pay_determin001",
      });
      return JSON.stringify(receipt);
    };
    expect(await run()).toBe(await run());
  });
});
