import {
  AigentiaError,
  errorMessage,
  isAigentiaError,
  isXrp,
  money,
  newId,
  parseDrops,
  xrp,
  type Logger,
  type Money,
} from "@aigentia/shared";
import { paymentReceiptSchema } from "@aigentia/protocol";
import type { PaymentIntent, PaymentReceipt } from "@aigentia/protocol";
import { explorerTxUrl, sendPayment } from "@aigentia/xrpl";
import { validatePaymentIntent } from "./intent";
import type {
  LedgerKind,
  PaymentExpectation,
  PaymentVerifier,
  TransactionSubmitter,
  VerifiedPayment,
  WalletProvider,
  XrplNetworkConfig,
} from "@aigentia/xrpl";

export interface PaymentExecutionContext {
  /** Opaque wallet handle of the paying agent, resolved by the WalletProvider. */
  readonly walletRef: string;
  readonly tick: number;
  /** x402 invoice id to stamp on the payment (memo + InvoiceID) and verify afterwards. */
  readonly invoiceId?: string;
  /** Free-text memo; defaults to the intent's memo. */
  readonly memo?: string;
  /** Payment row id for the receipt; defaults to newId("payment"). */
  readonly paymentId?: string;
}

/**
 * Moves the money an approved PaymentIntent describes and returns proof. Every receipt
 * references a transaction that was verified on the adapter's ledger after submission.
 * Throws AigentiaError("PAYMENT_FAILED") on any failure; `details.cause` carries the
 * underlying code (e.g. LEDGER_UNAVAILABLE, PAYMENT_UNVERIFIED) and `details.txHash` is set
 * whenever a transaction was submitted.
 */
export interface PaymentAdapter {
  readonly ledger: LedgerKind;
  execute(intent: PaymentIntent, ctx: PaymentExecutionContext): Promise<PaymentReceipt>;
}

/** The Money an intent moves, in the shape the XRPL payment builder expects. */
export function intentMoney(intent: Pick<PaymentIntent, "asset" | "amount">): Money {
  return isXrp(intent.asset) ? xrp(intent.amount) : money(intent.asset, intent.amount);
}

/** What the verifier must find on the ledger for this intent. */
export function intentExpectation(
  intent: Pick<PaymentIntent, "asset" | "amount" | "destinationAddress">,
  sender: string,
  invoiceId?: string,
): PaymentExpectation {
  const isNative = isXrp(intent.asset);
  return {
    destination: intent.destinationAddress,
    amountDrops: isNative ? parseDrops(intent.amount) : 0n,
    asset: intent.asset,
    ...(isNative ? {} : { amountValue: intent.amount }),
    sender,
    ...(invoiceId !== undefined ? { invoiceId } : {}),
  };
}

/** Receipt from a verified payment; validated against the protocol schema. */
export function receiptFromVerified(
  intent: PaymentIntent,
  verified: VerifiedPayment,
  ctx: PaymentExecutionContext,
  ledger: LedgerKind,
): PaymentReceipt {
  return paymentReceiptSchema.parse({
    paymentId: ctx.paymentId ?? newId("payment"),
    intentId: intent.id,
    txHash: verified.txHash,
    ledgerIndex: verified.ledgerIndex,
    validatedAt: verified.closeTime.toISOString(),
    senderAddress: verified.sender,
    receiverAddress: verified.destination,
    asset: intent.asset,
    amount: verified.amount.value,
    ledger,
    invoiceId: ctx.invoiceId ?? null,
  });
}

/** Re-validate an intent before touching a ledger; adapters never trust their input blindly. */
export function assertValidIntent(intent: PaymentIntent): void {
  validatePaymentIntent(intent);
}

/**
 * Normalise anything thrown while paying into PAYMENT_FAILED, preserving the original code
 * and details. VALIDATION_FAILED (a malformed intent or a refused signature) passes through:
 * it is a programming error, not a settlement outcome.
 */
export function asPaymentFailure(
  e: unknown,
  base: { intentId: string; ledger: LedgerKind; txHash?: string },
): AigentiaError {
  if (isAigentiaError(e)) {
    if (e.code === "VALIDATION_FAILED") return e;
    if (e.code === "PAYMENT_FAILED" && e.details?.["intentId"] === base.intentId) return e;
    const txHash = base.txHash ?? e.details?.["txHash"];
    return new AigentiaError("PAYMENT_FAILED", e.message, {
      ...(e.details ?? {}),
      cause: e.code,
      ...(typeof txHash === "string" ? { txHash } : {}),
      intentId: base.intentId,
      ledger: base.ledger,
    });
  }
  return new AigentiaError("PAYMENT_FAILED", errorMessage(e), {
    cause: "INTERNAL",
    ...(base.txHash !== undefined ? { txHash: base.txHash } : {}),
    intentId: base.intentId,
    ledger: base.ledger,
  });
}

export interface XRPLPaymentAdapterOptions {
  readonly logger?: Logger;
}

/**
 * Production adapter: builds, signs and submits a Payment through `sendPayment`, then
 * independently verifies the validated transaction with the PaymentVerifier before issuing
 * a receipt. Refuses to be constructed with anything but a Testnet submitter.
 */
export class XRPLPaymentAdapter implements PaymentAdapter {
  readonly ledger = "testnet" as const;

  constructor(
    private readonly client: TransactionSubmitter,
    private readonly walletProvider: WalletProvider,
    private readonly verifier: PaymentVerifier,
    readonly config: XrplNetworkConfig,
    private readonly options: XRPLPaymentAdapterOptions = {},
  ) {
    if (client.ledger !== "testnet") {
      throw new AigentiaError(
        "VALIDATION_FAILED",
        `XRPLPaymentAdapter requires a testnet submitter, got ledger "${client.ledger}"`,
        { ledger: client.ledger },
      );
    }
  }

  explorerUrl(txHash: string): string {
    return explorerTxUrl(this.config.explorerUrl, txHash);
  }

  async execute(intent: PaymentIntent, ctx: PaymentExecutionContext): Promise<PaymentReceipt> {
    assertValidIntent(intent);
    const base = { intentId: intent.id, ledger: this.ledger };
    let txHash: string | undefined;
    try {
      const sender = await this.walletProvider.getAddress(ctx.walletRef);
      const memoText = ctx.memo ?? intent.memo;
      const submitted = await sendPayment(this.client, this.walletProvider, ctx.walletRef, {
        destination: intent.destinationAddress,
        amount: intentMoney(intent),
        ...(ctx.invoiceId !== undefined ? { invoiceId: ctx.invoiceId } : {}),
        ...(memoText !== undefined ? { memoText } : {}),
      });
      txHash = submitted.hash;
      const verified = await this.verifier.verify(
        submitted.hash,
        intentExpectation(intent, sender, ctx.invoiceId),
      );
      const receipt = receiptFromVerified(intent, verified, ctx, this.ledger);
      this.options.logger?.info(
        {
          intentId: intent.id,
          txHash: receipt.txHash,
          ledgerIndex: receipt.ledgerIndex,
          explorerUrl: this.explorerUrl(receipt.txHash),
          tick: ctx.tick,
        },
        "payment validated on XRPL",
      );
      return receipt;
    } catch (e) {
      const failure = asPaymentFailure(e, txHash !== undefined ? { ...base, txHash } : base);
      this.options.logger?.warn(
        { intentId: intent.id, tick: ctx.tick, error: failure.toJSON() },
        "payment failed",
      );
      throw failure;
    }
  }
}
