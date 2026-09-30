import type { PaymentIntent, PaymentReceipt } from "@aigentia/protocol";
import { buildPaymentTx, type WalletProvider } from "@aigentia/xrpl";
import type { MockLedger } from "@aigentia/xrpl/testing";
import {
  asPaymentFailure,
  assertValidIntent,
  intentExpectation,
  intentMoney,
  receiptFromVerified,
  type PaymentAdapter,
  type PaymentExecutionContext,
} from "../payment-adapter";

/**
 * [MOCK] Settles approved intents on an in-process MockLedger. Runs the same pipeline as the
 * real adapter — build unsigned Payment → autofill → sign through the WalletProvider →
 * submit → verify — so the whole money path is exercised without a network. Every receipt it
 * returns is labelled `ledger: "mock"`. Never wire this into a SIM_LEDGER=testnet process.
 */
export class MockPaymentAdapter implements PaymentAdapter {
  readonly ledger = "mock" as const;

  constructor(
    private readonly mockLedger: MockLedger,
    private readonly walletProvider: WalletProvider,
  ) {
    console.warn(
      "[MOCK] MockPaymentAdapter: settles on the in-process MockLedger, never for production",
    );
  }

  async execute(intent: PaymentIntent, ctx: PaymentExecutionContext): Promise<PaymentReceipt> {
    assertValidIntent(intent);
    const base = { intentId: intent.id, ledger: this.ledger };
    let txHash: string | undefined;
    try {
      const account = await this.walletProvider.getAddress(ctx.walletRef);
      const memoText = ctx.memo ?? intent.memo;
      const unsigned = buildPaymentTx({
        account,
        destination: intent.destinationAddress,
        amount: intentMoney(intent),
        ...(ctx.invoiceId !== undefined ? { invoiceId: ctx.invoiceId } : {}),
        ...(memoText !== undefined ? { memoText } : {}),
      });
      const filled = await this.mockLedger.autofill(unsigned);
      const { txBlob } = await this.walletProvider.sign(ctx.walletRef, filled);
      const submitted = this.mockLedger.submitSigned(txBlob);
      txHash = submitted.hash;
      const verified = await this.mockLedger.verify(
        submitted.hash,
        intentExpectation(intent, account, ctx.invoiceId),
      );
      return receiptFromVerified(intent, verified, ctx, this.ledger);
    } catch (e) {
      throw asPaymentFailure(e, txHash !== undefined ? { ...base, txHash } : base);
    }
  }
}
