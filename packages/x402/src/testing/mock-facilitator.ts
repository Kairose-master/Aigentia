import type {
  PayerBuildRequest,
  PayerBuildResponse,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402SettlementResponse,
  X402SupportedResponse,
  X402VerifyResponse,
} from "@aigentia/protocol";
import { AigentiaError, errorMessage, xrp } from "@aigentia/shared";
import { buildPaymentTx } from "@aigentia/xrpl";
import type { MockLedger } from "@aigentia/xrpl/testing";
import type { Facilitator } from "../facilitator";
import { checkPresignedPayment, decodePresigned } from "../presigned";

export interface MockFacilitatorOptions {
  readonly network?: string;
  /** Fault injection: make settle report failure without touching the ledger. */
  readonly failSettle?: boolean;
}

/**
 * [MOCK] Facilitator for tests: the same offline checks as services/x402-xrpl, settling on the
 * in-process MockLedger (real signature verification, real hashes). Settlement is idempotent
 * by transaction hash, like the real service. Never used with SIM_LEDGER=testnet.
 */
export class MockFacilitator implements Facilitator {
  readonly kind = "mock" as const;
  readonly settleCalls: string[] = [];
  private readonly network: string;

  constructor(
    private readonly ledger: MockLedger,
    private readonly options: MockFacilitatorOptions = {},
  ) {
    this.network = options.network ?? "xrpl:1";
    console.warn("[MOCK] MockFacilitator: settles x402 payments on the in-process MockLedger");
  }

  async supported(): Promise<X402SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: this.network }],
      extensions: [],
      signers: {},
    };
  }

  async payerBuild(request: PayerBuildRequest): Promise<PayerBuildResponse> {
    const req = request.paymentRequirements;
    const invoiceId = req.extra?.invoiceId;
    if (!invoiceId) throw new AigentiaError("X402_UNTRUSTED", "missing_invoice_id");
    const unsigned = buildPaymentTx({
      account: request.account,
      destination: req.payTo,
      amount: xrp(req.amount),
      invoiceId,
      ...(req.extra?.sourceTag !== undefined ? { sourceTag: req.extra.sourceTag } : {}),
    });
    const filled = await this.ledger.autofill(unsigned);
    return {
      invoiceId,
      unsignedTx: filled,
      lastLedgerSequence: Number(filled["LastLedgerSequence"]),
      networkId: Number(this.network.split(":")[1]),
    };
  }

  async verify(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402VerifyResponse> {
    const reason = checkPresignedPayment(payload, requirements, this.network);
    const payer = decodePresigned(payload.payload.signedTxBlob)?.tx["Account"];
    const payerStr = typeof payer === "string" ? payer : null;
    return reason
      ? { isValid: false, invalidReason: reason, payer: payerStr }
      : { isValid: true, payer: payerStr };
  }

  async settle(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402SettlementResponse> {
    const verdict = await this.verify(payload, requirements);
    if (!verdict.isValid) {
      return {
        success: false,
        transaction: "",
        network: this.network,
        errorReason: verdict.invalidReason ?? "invalid",
      };
    }
    const decoded = decodePresigned(payload.payload.signedTxBlob);
    if (!decoded)
      return {
        success: false,
        transaction: "",
        network: this.network,
        errorReason: "invalid_tx_blob",
      };
    this.settleCalls.push(decoded.hash);
    if (this.options.failSettle) {
      return {
        success: false,
        transaction: "",
        network: this.network,
        errorReason: "mock_settle_failure",
      };
    }
    const existing = await this.ledger.getTransaction(decoded.hash);
    if (!existing) {
      try {
        this.ledger.submitSigned(payload.payload.signedTxBlob);
      } catch (e) {
        const result = e instanceof AigentiaError ? String(e.details?.["result"] ?? "") : "";
        return {
          success: false,
          transaction: "",
          network: this.network,
          errorReason: result || errorMessage(e),
        };
      }
    }
    return {
      success: true,
      transaction: decoded.hash,
      network: this.network,
      payer: verdict.payer ?? null,
    };
  }
}
