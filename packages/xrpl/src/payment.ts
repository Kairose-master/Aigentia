import { AigentiaError, utf8ToHex, type Money } from "@aigentia/shared";
import { moneyToXrplAmount } from "./asset";
import { invoiceIdToInvoiceField } from "./payment-verifier";
import type { SubmitResult, TransactionSubmitter, WalletProvider } from "./types";

export const MEMO_TYPE_INVOICE = utf8ToHex("aigentia/invoice");
export const MEMO_TYPE_TEXT = utf8ToHex("aigentia/memo");

export interface BuildPaymentParams {
  readonly account: string;
  readonly destination: string;
  readonly amount: Money;
  readonly invoiceId?: string;
  readonly memoText?: string;
  readonly sourceTag?: number;
  readonly destinationTag?: number;
}

export interface UnsignedPayment extends Record<string, unknown> {
  TransactionType: "Payment";
  Account: string;
  Destination: string;
  Amount: ReturnType<typeof moneyToXrplAmount>;
  Memos?: Array<{ Memo: { MemoType: string; MemoData: string; MemoFormat?: string } }>;
  InvoiceID?: string;
  SourceTag?: number;
  DestinationTag?: number;
}

/**
 * Unsigned Payment JSON. The invoice id is carried twice: as a UTF-8 memo (readable in
 * explorers) and as `InvoiceID = sha256(invoiceId)` (256-bit ledger field).
 */
export function buildPaymentTx(params: BuildPaymentParams): UnsignedPayment {
  if (params.account === params.destination) {
    throw new AigentiaError("VALIDATION_FAILED", "payment destination equals the sender", {
      account: params.account,
    });
  }
  const tx: UnsignedPayment = {
    TransactionType: "Payment",
    Account: params.account,
    Destination: params.destination,
    Amount: moneyToXrplAmount(params.amount),
  };
  const memos: NonNullable<UnsignedPayment["Memos"]> = [];
  if (params.invoiceId !== undefined) {
    memos.push({
      Memo: {
        MemoType: MEMO_TYPE_INVOICE,
        MemoData: utf8ToHex(params.invoiceId),
        MemoFormat: utf8ToHex("text/plain"),
      },
    });
    tx.InvoiceID = invoiceIdToInvoiceField(params.invoiceId);
  }
  if (params.memoText !== undefined) {
    memos.push({
      Memo: {
        MemoType: MEMO_TYPE_TEXT,
        MemoData: utf8ToHex(params.memoText),
        MemoFormat: utf8ToHex("text/plain"),
      },
    });
  }
  if (memos.length > 0) tx.Memos = memos;
  if (params.sourceTag !== undefined) tx.SourceTag = params.sourceTag;
  if (params.destinationTag !== undefined) tx.DestinationTag = params.destinationTag;
  return tx;
}

export type SendPaymentParams = Omit<BuildPaymentParams, "account">;

/**
 * Build → autofill → sign (via the WalletProvider's signer policy) → submit and wait.
 * Throws PAYMENT_FAILED unless the final result is tesSUCCESS.
 */
export async function sendPayment(
  client: TransactionSubmitter,
  walletProvider: WalletProvider,
  walletRef: string,
  params: SendPaymentParams,
): Promise<SubmitResult> {
  const account = await walletProvider.getAddress(walletRef);
  const unsigned = buildPaymentTx({ ...params, account });
  const filled = await client.autofill(unsigned);
  const { txBlob } = await walletProvider.sign(walletRef, filled);
  const submitted = await client.submitAndWait(txBlob);
  if (submitted.result !== "tesSUCCESS" || !submitted.validated) {
    throw new AigentiaError("PAYMENT_FAILED", `payment failed with ${submitted.result}`, {
      txHash: submitted.hash,
      result: submitted.result,
      validated: submitted.validated,
      ledger: submitted.ledger,
    });
  }
  return submitted;
}
