import { createPaymentIntent, receiptFromVerified, type PaymentAdapter } from "@aigentia/economy";
import type { X402Network, X402PaymentRequirements } from "@aigentia/protocol";
import {
  AigentiaError,
  SERVICE_KIND_CATEGORY,
  errorMessage,
  isAigentiaError,
  type Logger,
} from "@aigentia/shared";
import type { ServiceResponse, X402Client } from "@aigentia/x402";
import type { Clock } from "./context";
import type { EventLog } from "./events";
import type { IdGenerator } from "./ids";
import { applyAgentReputation } from "./reputation";
import { serviceInputError, validateServiceOutput } from "./services";
import type { PurchaseParams, PurchaseResult, ServicePurchaser, Settlement } from "./settlement";
import type { WorldStore } from "./store/types";
import { fmtXrp } from "./world";

export interface X402ServicePurchaserDeps {
  readonly store: WorldStore;
  readonly settlement: Settlement;
  readonly client: X402Client;
  readonly events: EventLog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly network: X402Network;
  readonly sourceTag: number;
  readonly maxTimeoutSeconds: number;
  readonly trustedFacilitators?: readonly string[];
  readonly logger?: Logger;
}

/**
 * Buys a service over HTTP x402, machine to machine:
 *   requestService → 402 → handle402 (untrusted input, fail closed) → PaymentIntent
 *   → PolicyEngine (inside Settlement) → obtainReceipt (build, check, sign) → retryWithReceipt
 *   → seller verifies + settles on XRPL → verifyResult (independent ledger proof) → output.
 * The service output only counts when the payment is proven on the ledger.
 */
export class X402ServicePurchaser implements ServicePurchaser {
  constructor(private readonly deps: X402ServicePurchaserDeps) {}

  async purchase(params: PurchaseParams): Promise<PurchaseResult> {
    const { store, settlement, client, events, ids, clock } = this.deps;
    const { buyer, service, tick } = params;
    const scope = params.scope ?? `${tick}:${buyer.id}`;
    const seller = await store.getAgent(service.sellerAgentId);
    if (!seller) throw new AigentiaError("NOT_FOUND", `seller ${service.sellerAgentId} not found`);
    const base = {
      invocationId: "",
      invoiceId: "",
      priceDrops: service.priceDrops,
      sellerAgentId: seller.id,
      sellerName: seller.name,
    };
    if (service.priceDrops > params.maxPriceDrops) {
      return {
        ...base,
        status: "rejected",
        error: `price ${service.priceDrops} drops exceeds the ceiling of ${params.maxPriceDrops} drops`,
      };
    }
    const inputError = serviceInputError(service.kind, params.input);
    if (inputError) return { ...base, status: "rejected", error: inputError };

    const body = { input: (params.input ?? {}) as Record<string, unknown>, tick };
    let requirements: X402PaymentRequirements;
    try {
      const quote = await client.requestService(service.endpoint, body);
      requirements = client.handle402(quote, {
        network: this.deps.network,
        allowedAssets: buyer.budgetPolicy.allowedAssets,
        listedPriceDrops: service.priceDrops,
        maxPriceDrops: params.maxPriceDrops,
        payTo: seller.walletAddress,
        sourceTag: this.deps.sourceTag,
        trustedFacilitators: this.deps.trustedFacilitators ?? [],
        maxTimeoutSeconds: this.deps.maxTimeoutSeconds,
      });
    } catch (e) {
      const reason = isAigentiaError(e) ? String(e.details?.["reason"] ?? e.code) : errorMessage(e);
      return { ...base, status: "rejected", error: `x402 quote refused: ${reason}` };
    }
    const invoiceId = requirements.extra?.invoiceId ?? "";
    const invocationId = (await store.getInvocationByInvoice(invoiceId))?.id ?? invoiceId;
    const common = { ...base, invocationId, invoiceId };
    const category = SERVICE_KIND_CATEGORY[service.kind];
    const now = clock();
    const intent = createPaymentIntent({
      id: ids.next("intent", scope),
      agentId: buyer.id,
      purpose: "x402",
      destinationAddress: requirements.payTo,
      destinationAgentId: seller.id,
      amount: BigInt(requirements.amount),
      serviceCategory: category,
      actionRef: { kind: "invocation", id: invocationId },
      memo: `x402 ${service.kind} ${invoiceId}`.slice(0, 200),
      createdAt: now.toISOString(),
    });

    // The PolicyEngine runs inside Settlement.pay BEFORE this adapter is ever called.
    let delivered: ServiceResponse | null = null;
    let sellerError: string | null = null;
    const adapter: PaymentAdapter = {
      ledger: settlement.ledger,
      execute: async (payIntent, ctx) => {
        const receipt = await client.obtainReceipt(requirements, {
          walletRef: buyer.walletRef,
          account: buyer.walletAddress,
          resource: { url: service.endpoint, description: `${service.kind} by ${seller.name}` },
        });
        try {
          delivered = await client.retryWithReceipt(service.endpoint, body, receipt);
        } catch (e) {
          sellerError = errorMessage(e);
        }
        try {
          const verified = await client.verifyResult(receipt, requirements, buyer.walletAddress);
          return receiptFromVerified(payIntent, verified, ctx, settlement.ledger);
        } catch (e) {
          const current = delivered as ServiceResponse | null;
          const detail =
            sellerError ?? (current ? `seller answered HTTP ${current.status}` : "no answer");
          throw new AigentiaError(
            "PAYMENT_FAILED",
            `x402 payment not settled (${detail}): ${errorMessage(e)}`,
            {
              txHash: receipt.txHash,
              cause: isAigentiaError(e) ? e.code : "UNKNOWN",
            },
          );
        }
      },
    };

    const outcome = await settlement.pay(intent, {
      agent: buyer,
      tick,
      invoiceId,
      scope,
      description: `for ${service.kind} ${category} (x402)`,
      adapter,
    });
    if (outcome.status === "denied") {
      const error = `payment denied: ${outcome.decision.violations.map((v) => v.rule).join(", ")}`;
      return {
        ...common,
        status: "denied",
        paymentId: outcome.paymentId,
        error,
        decision: outcome.decision,
      };
    }
    if (outcome.status === "failed") {
      return {
        ...common,
        status: "payment_failed",
        paymentId: outcome.paymentId,
        ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
        error: outcome.error ?? "payment failed",
        decision: outcome.decision,
      };
    }

    const txHash = outcome.txHash ?? "";
    if (invocationId !== invoiceId || (await store.getInvocation(invocationId))) {
      await store
        .updateInvocation(invocationId, { paymentId: outcome.paymentId })
        .catch(() => undefined);
    }
    await events.emitOne({
      tick,
      at: now,
      type: "SERVICE_PURCHASED",
      agentId: buyer.id,
      counterpartyId: seller.id,
      txHash,
      amountDrops: service.priceDrops,
      message: `${buyer.name} paid ${seller.name} ${fmtXrp(service.priceDrops)} for ${service.kind} ${category} over x402`,
      payload: { invocationId, serviceId: service.id, paymentId: outcome.paymentId },
    });

    const response = delivered as ServiceResponse | null;
    const rawOutput = (response?.body as { output?: unknown } | null)?.output;
    if (response?.status === 200 && rawOutput !== undefined) {
      try {
        const output = validateServiceOutput(service.kind, rawOutput) as unknown as Record<
          string,
          unknown
        >;
        await applyAgentReputation(store, buyer.id, "SERVICE_SUCCESS_BUYER", {
          tick,
          at: now,
          ids,
          scope,
          refKind: "invocation",
          refId: invocationId,
        });
        return {
          ...common,
          status: "fulfilled",
          paymentId: outcome.paymentId,
          txHash,
          output,
          decision: outcome.decision,
        };
      } catch (e) {
        return {
          ...common,
          status: "service_failed",
          paymentId: outcome.paymentId,
          txHash,
          error: `invalid output: ${errorMessage(e)}`,
          decision: outcome.decision,
        };
      }
    }
    const reason = sellerError ?? `seller answered HTTP ${response?.status ?? "none"}`;
    return {
      ...common,
      status: "service_failed",
      paymentId: outcome.paymentId,
      txHash,
      error: reason,
      decision: outcome.decision,
    };
  }
}
