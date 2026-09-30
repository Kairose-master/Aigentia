import { describe, expect, it } from "vitest";
import type { X402PaymentRequirements } from "@aigentia/protocol";
import { MockLedger, MockWalletProvider } from "@aigentia/xrpl/testing";
import {
  buildPaymentRequired,
  validatePaymentRequirements,
  type RequirementExpectation,
} from "./requirements";
import { decodePaymentResponse, decodePaymentSignature, encodePaymentResponse } from "./headers";
import { assertUnsignedPaymentMatches } from "./unsigned-tx";
import { X402Client } from "./client";
import type { FetchFn } from "./facilitator";
import { MockFacilitator } from "./testing";
import { checkPresignedPayment } from "./presigned";

const SELLER = "rhaDe3NBxgUSLL12N5Sxpii2xy8vSyXNG6";
const SOURCE_TAG = 804681468;

function quote(overrides: Partial<Parameters<typeof buildPaymentRequired>[0]> = {}) {
  return buildPaymentRequired({
    resourceUrl: "http://seller.test/services/svc_x/invoke",
    description: "SCOUT",
    network: "xrpl:1",
    payTo: SELLER,
    amountDrops: 1000n,
    invoiceId: "inv_abc123",
    sourceTag: SOURCE_TAG,
    maxTimeoutSeconds: 120,
    ...overrides,
  });
}

const expectation: RequirementExpectation = {
  network: "xrpl:1",
  allowedAssets: ["XRP"],
  listedPriceDrops: 1000n,
  maxPriceDrops: 5000n,
  payTo: SELLER,
  sourceTag: SOURCE_TAG,
  trustedFacilitators: [],
  maxTimeoutSeconds: 120,
};

function mutate(fn: (req: Record<string, unknown>) => void): unknown {
  const body = JSON.parse(JSON.stringify(quote())) as { accepts: Record<string, unknown>[] };
  const first = body.accepts[0];
  if (first) fn(first);
  return body;
}

describe("handle402: remote payment requirements are untrusted", () => {
  it("accepts a quote that matches the marketplace record exactly", () => {
    expect(validatePaymentRequirements(quote(), expectation).amount).toBe("1000");
  });

  const cases: [string, unknown, string][] = [
    ["garbage body", { hello: "world" }, "malformed_402"],
    ["x402 v1", { ...quote(), x402Version: 1 }, "malformed_402"],
    ["mainnet", mutate((r) => (r["network"] = "xrpl:0")), "network_mismatch"],
    ["other chain", mutate((r) => (r["network"] = "eip155:8453")), "malformed_402"],
    ["unsupported scheme", mutate((r) => (r["scheme"] = "upto")), "no_supported_requirement"],
    ["IOU asset", mutate((r) => (r["asset"] = "USD")), "asset_not_allowed"],
    ["price above listing", mutate((r) => (r["amount"] = "2000")), "amount_mismatch"],
    ["decimal drops", mutate((r) => (r["amount"] = "10.5")), "invalid_amount"],
    ["zero amount", mutate((r) => (r["amount"] = "0")), "invalid_amount"],
    [
      "other destination",
      mutate((r) => (r["payTo"] = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe")),
      "destination_mismatch",
    ],
    ["malformed destination", mutate((r) => (r["payTo"] = "0xdeadbeef")), "malformed_402"],
    ["no invoice", mutate((r) => (r["extra"] = { sourceTag: SOURCE_TAG })), "missing_invoice"],
    [
      "foreign source tag",
      mutate((r) => (r["extra"] = { invoiceId: "i", sourceTag: 1 })),
      "source_tag_mismatch",
    ],
    [
      "unknown facilitator",
      mutate(
        (r) =>
          (r["extra"] = { invoiceId: "i", sourceTag: SOURCE_TAG, facilitator: { id: "evil" } }),
      ),
      "untrusted_facilitator",
    ],
    [
      "destination tag",
      mutate((r) => (r["extra"] = { invoiceId: "i", sourceTag: SOURCE_TAG, destinationTag: 7 })),
      "unexpected_destination_tag",
    ],
    ["long quote", mutate((r) => (r["maxTimeoutSeconds"] = 86_400)), "timeout_too_long"],
  ];
  it.each(cases)("fails closed on %s", (_label, body, reason) => {
    expect(() => validatePaymentRequirements(body, expectation)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason }) }),
    );
  });

  it("refuses a listed price above the buyer's ceiling", () => {
    expect(() =>
      validatePaymentRequirements(quote(), { ...expectation, maxPriceDrops: 999n }),
    ).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "amount_exceeds_ceiling" }),
      }),
    );
  });

  it("accepts a trusted facilitator", () => {
    const body = mutate(
      (r) => (r["extra"] = { invoiceId: "i", sourceTag: SOURCE_TAG, facilitator: { id: "ok" } }),
    );
    expect(
      validatePaymentRequirements(body, { ...expectation, trustedFacilitators: ["ok"] }).payTo,
    ).toBe(SELLER);
  });
});

describe("headers", () => {
  it("rejects malformed PAYMENT-SIGNATURE and PAYMENT-RESPONSE headers", () => {
    expect(() => decodePaymentSignature("not base64 !!")).toThrow(
      expect.objectContaining({ code: "X402_MALFORMED" }),
    );
    expect(() => decodePaymentSignature(Buffer.from("{}").toString("base64"))).toThrow(
      expect.objectContaining({ code: "X402_MALFORMED" }),
    );
    const s = { success: true, transaction: "AB".repeat(32), network: "xrpl:1" };
    expect(decodePaymentResponse(encodePaymentResponse(s))).toEqual(s);
  });
});

async function world() {
  const ledger = new MockLedger();
  const wallets = new MockWalletProvider("x402-test");
  const buyer = await wallets.ensureWallet("buyer");
  const seller = await wallets.ensureWallet("seller");
  ledger.fund(buyer.address, 50_000_000n);
  ledger.fund(seller.address, 20_000_000n);
  const facilitator = new MockFacilitator(ledger);
  return { ledger, wallets, buyer, seller, facilitator };
}

describe("unsigned transaction guard", () => {
  it("refuses a built transaction that differs from the validated requirements", async () => {
    const { facilitator, buyer, seller } = await world();
    const req = validatePaymentRequirements(quote({ payTo: seller.address }), {
      ...expectation,
      payTo: seller.address,
    });
    const built = await facilitator.payerBuild({
      account: buyer.address,
      paymentRequirements: req,
      maxFeeDrops: 10_000,
    });
    const base = {
      account: buyer.address,
      requirements: req,
      invoiceId: "inv_abc123",
      maxFeeDrops: 10_000n,
      networkId: 1,
    };
    expect(() => assertUnsignedPaymentMatches(built.unsignedTx, base)).not.toThrow();
    const tampered: [string, Record<string, unknown>][] = [
      ["amount", { Amount: "1000000" }],
      ["destination", { Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" }],
      ["fee", { Fee: "999999" }],
      ["partial payment", { Flags: 0x00020000 }],
      ["SendMax", { SendMax: "5000000" }],
      ["invoice", { InvoiceID: "00".repeat(32), Memos: [] }],
      ["source tag", { SourceTag: 1 }],
      ["account", { Account: seller.address }],
    ];
    for (const [label, patch] of tampered) {
      expect(
        () => assertUnsignedPaymentMatches({ ...built.unsignedTx, ...patch }, base),
        label,
      ).toThrow(expect.objectContaining({ code: "X402_UNTRUSTED" }));
    }
  });
});

describe("X402Client round trip on the [MOCK] ledger", () => {
  async function setup(opts: { lie?: boolean } = {}) {
    const w = await world();
    const requirements: X402PaymentRequirements = validatePaymentRequirements(
      quote({ payTo: w.seller.address }),
      { ...expectation, payTo: w.seller.address },
    );
    // A tiny seller: 402 without a header, settle-then-deliver with one.
    const fetchFn: FetchFn = async (_url, init) => {
      const headers = new Headers(init?.headers);
      const signature = headers.get("payment-signature");
      if (!signature) return Response.json(quote({ payTo: w.seller.address }), { status: 402 });
      const payload = decodePaymentSignature(signature);
      const settlement = await w.facilitator.settle(payload, requirements);
      const reported = opts.lie ? { ...settlement, transaction: "CD".repeat(32) } : settlement;
      return Response.json(
        { ok: settlement.success },
        {
          status: settlement.success ? 200 : 402,
          headers: { "payment-response": encodePaymentResponse(reported) },
        },
      );
    };
    const client = new X402Client({
      fetch: fetchFn,
      facilitator: w.facilitator,
      walletProvider: w.wallets,
      verifier: w.ledger,
      network: "xrpl:1",
      networkId: 1,
    });
    return { ...w, client, requirements };
  }

  it("402 → sign → retry → settle → independent ledger verification", async () => {
    const { client, buyer, seller, ledger } = await setup();
    const endpoint = "http://seller.test/services/svc_x/invoke";
    const first = await client.requestService(endpoint, { input: {} });
    const req = client.handle402(first, { ...expectation, payTo: seller.address });
    const receipt = await client.obtainReceipt(req, { walletRef: "buyer", account: buyer.address });
    const second = await client.retryWithReceipt(endpoint, { input: {} }, receipt);
    expect(second.status).toBe(200);
    expect(second.settlement?.transaction).toBe(receipt.txHash);
    const verified = await client.verifyResult(receipt, req, buyer.address);
    expect(verified.amount.value).toBe("1000");
    expect(verified.invoiceId).toBe("inv_abc123");
    expect((await ledger.getBalanceDrops(seller.address)).balanceDrops).toBe(20_001_000n);
  });

  it("settling the same receipt twice is idempotent: one ledger transaction", async () => {
    const { client, buyer, seller, facilitator, ledger, requirements } = await setup();
    const receipt = await client.obtainReceipt(requirements, {
      walletRef: "buyer",
      account: buyer.address,
    });
    const a = await facilitator.settle(receipt.payload, requirements);
    const b = await facilitator.settle(receipt.payload, requirements);
    expect(a.success && b.success).toBe(true);
    expect(a.transaction).toBe(b.transaction);
    expect((await ledger.getBalanceDrops(seller.address)).balanceDrops).toBe(20_001_000n);
  });

  it("rejects a seller that reports a different transaction than the one signed", async () => {
    const { client, buyer, requirements } = await setup({ lie: true });
    const receipt = await client.obtainReceipt(requirements, {
      walletRef: "buyer",
      account: buyer.address,
    });
    await expect(
      client.retryWithReceipt("http://seller.test/x", {}, receipt),
    ).rejects.toMatchObject({
      code: "X402_UNTRUSTED",
    });
  });

  it("a receipt for one invoice cannot pay another quote", async () => {
    const { client, buyer, seller, requirements } = await setup();
    const receipt = await client.obtainReceipt(requirements, {
      walletRef: "buyer",
      account: buyer.address,
    });
    const other = validatePaymentRequirements(
      quote({ payTo: seller.address, invoiceId: "inv_other" }),
      { ...expectation, payTo: seller.address },
    );
    expect(checkPresignedPayment(receipt.payload, other, "xrpl:1")).toBe("requirements_mismatch");
  });
});
