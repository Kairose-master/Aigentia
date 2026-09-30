import type {
  PaidService,
  PaymentIntent,
  PolicyDecision,
  X402Network,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402ResourceInfo,
  X402SettlementResponse,
} from "@aigentia/protocol";
import { X402_HEADERS } from "@aigentia/protocol";
import { AigentiaError, XRP, errorMessage, type ServiceKind } from "@aigentia/shared";
import type { PaymentVerifier, VerifiedPayment, WalletProvider } from "@aigentia/xrpl";
import type { Facilitator, FetchFn } from "./facilitator";
import { decodePaymentResponse, encodePaymentSignature } from "./headers";
import { validatePaymentRequirements, type RequirementExpectation } from "./requirements";
import { assertUnsignedPaymentMatches } from "./unsigned-tx";

/** Where the buyer learns which services exist (the marketplace, never the remote server). */
export interface ServiceDirectory {
  listPaidServices(kind: ServiceKind): Promise<PaidService[]>;
}

export interface ServiceResponse {
  readonly status: number;
  readonly body: unknown;
  /** Decoded PAYMENT-RESPONSE header, when present and well-formed. */
  readonly settlement: X402SettlementResponse | null;
  /** Set when a PAYMENT-RESPONSE header was present but malformed. */
  readonly settlementError?: string;
}

/** Proof of payment the buyer attaches to the retried request. */
export interface PaymentReceiptHeader {
  readonly paymentHeader: string;
  readonly payload: X402PaymentPayload;
  /** Hash of the transaction the buyer signed: known before settlement, used to verify it. */
  readonly txHash: string;
  readonly invoiceId: string;
}

export interface X402ClientDeps {
  readonly fetch?: FetchFn;
  readonly facilitator: Facilitator;
  readonly walletProvider: WalletProvider;
  readonly verifier: PaymentVerifier;
  readonly network: X402Network;
  readonly networkId: number;
  /** Fee ceiling for the presigned Payment. */
  readonly maxFeeDrops?: bigint;
  /** Timeout for the retried (settling) request. */
  readonly settleTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

/**
 * The buyer side of x402 over XRPL. Each step is separate so the game engine can put the
 * PolicyEngine between "we know the price" and "we sign anything":
 *
 *   discoverService → requestService → handle402 → authorizePayment → obtainReceipt
 *   → retryWithReceipt → verifyResult
 */
export class X402Client {
  private readonly fetchFn: FetchFn;
  private readonly maxFeeDrops: bigint;

  constructor(private readonly deps: X402ClientDeps) {
    this.fetchFn = deps.fetch ?? fetch;
    this.maxFeeDrops = deps.maxFeeDrops ?? 10_000n;
  }

  /** Candidate services of a kind, from the buyer's trusted directory. */
  async discoverService(kind: ServiceKind, directory: ServiceDirectory): Promise<PaidService[]> {
    const services = await directory.listPaidServices(kind);
    return services.filter((s) => s.kind === kind);
  }

  /** POST the call; without `paymentHeader` a paid endpoint answers 402. Never throws on HTTP status. */
  async requestService(
    endpoint: string,
    body: Record<string, unknown>,
    paymentHeader?: string,
    timeoutMs?: number,
  ): Promise<ServiceResponse> {
    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(paymentHeader ? { [X402_HEADERS.paymentSignature]: paymentHeader } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.deps.requestTimeoutMs ?? 20_000),
      });
    } catch (e) {
      throw new AigentiaError(
        "LEDGER_UNAVAILABLE",
        `service endpoint unreachable: ${errorMessage(e)}`,
        {
          endpoint,
        },
      );
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    const header = response.headers.get(X402_HEADERS.paymentResponse);
    if (!header) return { status: response.status, body: parsed, settlement: null };
    try {
      return { status: response.status, body: parsed, settlement: decodePaymentResponse(header) };
    } catch (e) {
      return {
        status: response.status,
        body: parsed,
        settlement: null,
        settlementError: errorMessage(e),
      };
    }
  }

  /** Validate a 402 as untrusted input; returns the one requirement the buyer may pay. */
  handle402(response: ServiceResponse, expect: RequirementExpectation): X402PaymentRequirements {
    if (response.status !== 402) {
      throw new AigentiaError("X402_MALFORMED", `expected HTTP 402, got ${response.status}`, {
        status: response.status,
      });
    }
    return validatePaymentRequirements(response.body, expect);
  }

  /** Ask the caller's policy (the PolicyEngine) to approve the intent; throws POLICY_DENIED otherwise. */
  async authorizePayment(
    intent: PaymentIntent,
    authorize: (intent: PaymentIntent) => Promise<PolicyDecision>,
  ): Promise<PolicyDecision> {
    const decision = await authorize(intent);
    if (!decision.approved) {
      throw new AigentiaError("POLICY_DENIED", "payment denied by policy", {
        violations: decision.violations.map((v) => v.rule),
      });
    }
    return decision;
  }

  /**
   * Build (via the payment service), check and sign the presigned Payment; returns the
   * PAYMENT-SIGNATURE header. The seed never leaves the WalletProvider and the LLM never sees
   * any of this.
   */
  async obtainReceipt(
    requirements: X402PaymentRequirements,
    payer: {
      readonly walletRef: string;
      readonly account: string;
      readonly resource?: X402ResourceInfo;
    },
  ): Promise<PaymentReceiptHeader> {
    const invoiceId = requirements.extra?.invoiceId;
    if (!invoiceId) throw new AigentiaError("X402_UNTRUSTED", "requirements carry no invoice id");
    const built = await this.deps.facilitator.payerBuild({
      account: payer.account,
      paymentRequirements: requirements,
      ...(payer.resource ? { resource: payer.resource } : {}),
      maxFeeDrops: Number(this.maxFeeDrops),
    });
    if (built.invoiceId !== invoiceId) {
      throw new AigentiaError("X402_UNTRUSTED", "payment service changed the invoice id", {
        expected: invoiceId,
        actual: built.invoiceId,
      });
    }
    assertUnsignedPaymentMatches(built.unsignedTx, {
      account: payer.account,
      requirements,
      invoiceId,
      maxFeeDrops: this.maxFeeDrops,
      networkId: this.deps.networkId,
    });
    const signed = await this.deps.walletProvider.sign(payer.walletRef, built.unsignedTx);
    const payload: X402PaymentPayload = {
      x402Version: 2,
      ...(payer.resource ? { resource: payer.resource } : {}),
      accepted: requirements,
      payload: { signedTxBlob: signed.txBlob, invoiceId },
    };
    return {
      paymentHeader: encodePaymentSignature(payload),
      payload,
      txHash: signed.hash,
      invoiceId,
    };
  }

  /**
   * Retry the call with the PAYMENT-SIGNATURE. The seller verifies and settles through its
   * facilitator, then answers with the resource and a PAYMENT-RESPONSE. A settlement for a
   * different transaction than the one we signed is rejected.
   */
  async retryWithReceipt(
    endpoint: string,
    body: Record<string, unknown>,
    receipt: PaymentReceiptHeader,
    timeoutMs?: number,
  ): Promise<ServiceResponse> {
    const response = await this.requestService(
      endpoint,
      body,
      receipt.paymentHeader,
      timeoutMs ?? this.deps.settleTimeoutMs ?? 180_000,
    );
    const s = response.settlement;
    if (s && s.success && s.transaction.toUpperCase() !== receipt.txHash.toUpperCase()) {
      throw new AigentiaError(
        "X402_UNTRUSTED",
        "seller reported settlement of a different transaction",
        {
          signed: receipt.txHash,
          reported: s.transaction,
        },
      );
    }
    return response;
  }

  /**
   * Independent ledger proof: the transaction the buyer signed is validated, succeeded, paid
   * exactly the quoted amount to the quoted destination and is bound to the invoice. The
   * facilitator's `success: true` alone is never trusted.
   */
  async verifyResult(
    receipt: PaymentReceiptHeader,
    requirements: X402PaymentRequirements,
    payerAccount: string,
  ): Promise<VerifiedPayment> {
    return this.deps.verifier.verify(receipt.txHash, {
      destination: requirements.payTo,
      amountDrops: BigInt(requirements.amount),
      asset: XRP,
      sender: payerAccount,
      invoiceId: receipt.invoiceId,
    });
  }
}
