import { describe, expect, it } from "vitest";
import { AigentiaError, isAigentiaError, xrp } from "@aigentia/shared";
import type {
  PaymentExpectation,
  PaymentVerifier,
  SubmitResult,
  TransactionSubmitter,
  VerifiedPayment,
  WalletProvider,
  XrplNetworkConfig,
} from "@aigentia/xrpl";
import { createPaymentIntent } from "./intent";
import { XRPLPaymentAdapter, asPaymentFailure } from "./payment-adapter";

const SENDER = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const DEST = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const HASH = "A".repeat(64);

const config: XrplNetworkConfig = {
  name: "testnet",
  caip2: "xrpl:1",
  networkId: 1,
  wssUrl: "wss://testnet.example/",
  rpcUrl: "https://testnet.example/",
  explorerUrl: "https://testnet.xrpl.org",
  faucetUrl: "https://faucet.example/accounts",
};

const intent = createPaymentIntent({
  id: "pin_adapter00001",
  agentId: "agt_buyer00001",
  purpose: "x402",
  destinationAddress: DEST,
  destinationAgentId: "agt_seller0001",
  amount: 250_000n,
  serviceCategory: "intelligence",
  actionRef: { kind: "invocation", id: "inv_1" },
  memo: "scout run",
});

class StubSubmitter implements TransactionSubmitter {
  readonly ledger = "testnet" as const;
  autofilled: Record<string, unknown> | null = null;
  submitted: string[] = [];
  constructor(private readonly outcome: () => SubmitResult) {}
  async autofill(tx: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.autofilled = tx;
    return { ...tx, Sequence: 7, Fee: "12", LastLedgerSequence: 1_000 };
  }
  async submitAndWait(txBlob: string): Promise<SubmitResult> {
    this.submitted.push(txBlob);
    return this.outcome();
  }
}

const stubWallets: WalletProvider = {
  async ensureWallet(): Promise<{ address: string; created: boolean }> {
    return { address: SENDER, created: false };
  },
  async getAddress(): Promise<string> {
    return SENDER;
  },
  async sign(): Promise<{ txBlob: string; hash: string }> {
    return { txBlob: "DEADBEEF", hash: HASH };
  },
};

class StubVerifier implements PaymentVerifier {
  calls: Array<{ txHash: string; expect: PaymentExpectation }> = [];
  constructor(private readonly outcome: (txHash: string) => VerifiedPayment) {}
  async verify(txHash: string, expect: PaymentExpectation): Promise<VerifiedPayment> {
    this.calls.push({ txHash, expect });
    return this.outcome(txHash);
  }
}

const success = (): SubmitResult => ({
  hash: HASH,
  ledgerIndex: 1_234,
  result: "tesSUCCESS",
  validated: true,
  deliveredDrops: 250_000n,
  meta: { TransactionResult: "tesSUCCESS" },
  ledger: "testnet",
});

const verifiedOk = (txHash: string): VerifiedPayment => ({
  txHash,
  ledgerIndex: 1_234,
  closeTime: new Date("2026-05-01T12:00:04.000Z"),
  sender: SENDER,
  destination: DEST,
  amount: xrp(250_000),
  feeDrops: 12n,
  invoiceId: "inv_1",
  ledger: "testnet",
});

async function failure(p: Promise<unknown>): Promise<AigentiaError> {
  try {
    await p;
  } catch (e) {
    if (isAigentiaError(e)) return e;
    throw new Error(`expected AigentiaError, got ${String(e)}`);
  }
  throw new Error("expected a rejection");
}

describe("XRPLPaymentAdapter", () => {
  it("submits, verifies and returns a testnet receipt", async () => {
    const client = new StubSubmitter(success);
    const verifier = new StubVerifier(verifiedOk);
    const adapter = new XRPLPaymentAdapter(client, stubWallets, verifier, config);
    const receipt = await adapter.execute(intent, {
      walletRef: "buyer",
      tick: 3,
      invoiceId: "inv_1",
      paymentId: "pay_fixed000001",
    });

    expect(receipt).toEqual({
      paymentId: "pay_fixed000001",
      intentId: intent.id,
      txHash: HASH,
      ledgerIndex: 1_234,
      validatedAt: "2026-05-01T12:00:04.000Z",
      senderAddress: SENDER,
      receiverAddress: DEST,
      asset: { code: "XRP" },
      amount: "250000",
      ledger: "testnet",
      invoiceId: "inv_1",
    });
    expect(adapter.explorerUrl(receipt.txHash)).toBe(
      `https://testnet.xrpl.org/transactions/${HASH}`,
    );
    expect(client.autofilled).toMatchObject({
      TransactionType: "Payment",
      Account: SENDER,
      Destination: DEST,
      Amount: "250000",
    });
    expect(client.submitted).toEqual(["DEADBEEF"]);
    expect(verifier.calls).toHaveLength(1);
    expect(verifier.calls[0]).toEqual({
      txHash: HASH,
      expect: {
        destination: DEST,
        amountDrops: 250_000n,
        asset: { code: "XRP" },
        sender: SENDER,
        invoiceId: "inv_1",
      },
    });
  });

  it("propagates PAYMENT_FAILED from the ledger and never verifies", async () => {
    const client = new StubSubmitter(() => ({
      ...success(),
      result: "tecUNFUNDED_PAYMENT",
      validated: true,
    }));
    const verifier = new StubVerifier(verifiedOk);
    const adapter = new XRPLPaymentAdapter(client, stubWallets, verifier, config);
    const err = await failure(adapter.execute(intent, { walletRef: "buyer", tick: 1 }));
    expect(err.code).toBe("PAYMENT_FAILED");
    expect(err.details).toMatchObject({
      result: "tecUNFUNDED_PAYMENT",
      txHash: HASH,
      intentId: intent.id,
      ledger: "testnet",
    });
    expect(verifier.calls).toHaveLength(0);
  });

  it("returns no receipt when verification fails, and reports the tx hash", async () => {
    const client = new StubSubmitter(success);
    const verifier = new StubVerifier((txHash) => {
      throw new AigentiaError("PAYMENT_UNVERIFIED", "amount mismatch", { txHash });
    });
    const adapter = new XRPLPaymentAdapter(client, stubWallets, verifier, config);
    const err = await failure(adapter.execute(intent, { walletRef: "buyer", tick: 1 }));
    expect(err.code).toBe("PAYMENT_FAILED");
    expect(err.details).toMatchObject({
      cause: "PAYMENT_UNVERIFIED",
      txHash: HASH,
      intentId: intent.id,
    });
    expect(verifier.calls).toHaveLength(1);
  });

  it("wraps connection loss as PAYMENT_FAILED with the original cause", async () => {
    const client = new StubSubmitter(() => {
      throw new AigentiaError("LEDGER_UNAVAILABLE", "socket closed");
    });
    const adapter = new XRPLPaymentAdapter(
      client,
      stubWallets,
      new StubVerifier(verifiedOk),
      config,
    );
    const err = await failure(adapter.execute(intent, { walletRef: "buyer", tick: 1 }));
    expect(err.code).toBe("PAYMENT_FAILED");
    expect(err.details).toMatchObject({ cause: "LEDGER_UNAVAILABLE", intentId: intent.id });
    expect(err.details?.["txHash"]).toBeUndefined();
  });

  it("refuses a non-testnet submitter and malformed intents", () => {
    const stub = new StubSubmitter(success);
    const mockish: TransactionSubmitter = {
      ledger: "mock",
      autofill: (tx) => stub.autofill(tx),
      submitAndWait: (blob) => stub.submitAndWait(blob),
    };
    expect(
      () => new XRPLPaymentAdapter(mockish, stubWallets, new StubVerifier(verifiedOk), config),
    ).toThrow(/testnet/);

    const adapter = new XRPLPaymentAdapter(
      new StubSubmitter(success),
      stubWallets,
      new StubVerifier(verifiedOk),
      config,
    );
    const broken = { ...intent, amount: "0" };
    return expect(adapter.execute(broken, { walletRef: "buyer", tick: 1 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("asPaymentFailure normalises unknown errors", () => {
    const wrapped = asPaymentFailure(new Error("boom"), { intentId: "pin_x", ledger: "testnet" });
    expect(wrapped.code).toBe("PAYMENT_FAILED");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.details).toEqual({ cause: "INTERNAL", intentId: "pin_x", ledger: "testnet" });
    const own = new AigentiaError("PAYMENT_FAILED", "already", { intentId: "pin_x" });
    expect(asPaymentFailure(own, { intentId: "pin_x", ledger: "testnet" })).toBe(own);
  });
});
