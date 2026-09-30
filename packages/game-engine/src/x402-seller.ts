import {
  x402PaymentRequirementsSchema,
  type X402Network,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SettlementResponse,
} from "@aigentia/protocol";
import {
  AigentiaError,
  SERVICE_KIND_CATEGORY,
  XRP,
  errorMessage,
  isAigentiaError,
  type Logger,
} from "@aigentia/shared";
import {
  buildPaymentRequired,
  decodePaymentSignature,
  decodePresigned,
  encodePaymentResponse,
  type Facilitator,
} from "@aigentia/x402";
import type { PaymentVerifier } from "@aigentia/xrpl";
import { z } from "zod";
import type { Clock } from "./context";
import type { EventLog } from "./events";
import type { IdGenerator } from "./ids";
import { applyAgentReputation } from "./reputation";
import {
  executeService,
  serviceInputError,
  validateServiceOutput,
  type ServiceExecutor,
} from "./services";
import type { InvocationRecord, ServiceRecord, WorldStore } from "./store/types";
import { fmtXrp } from "./world";

export interface SellerGateDeps {
  readonly store: WorldStore;
  readonly facilitator: Facilitator;
  /** Independent ledger proof of settlement; the facilitator's word alone is not enough. */
  readonly verifier: PaymentVerifier;
  readonly events: EventLog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly network: X402Network;
  readonly sourceTag: number;
  readonly maxTimeoutSeconds: number;
  readonly executeService?: ServiceExecutor;
  readonly logger?: Logger;
}

export interface SellerRequest {
  readonly serviceId: string;
  readonly body: unknown;
  /** Raw PAYMENT-SIGNATURE header, if any. */
  readonly paymentHeader?: string | undefined;
  /** Absolute URL of the resource, echoed in the 402. */
  readonly resourceUrl: string;
}

export interface SellerResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

const invokeBodySchema = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  /** The buyer's tick, used only to label events; clamped to the current/next tick. */
  tick: z.number().int().min(0).optional(),
});

const PAYMENT_RESPONSE = "payment-response";

function json(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): SellerResponse {
  return { status, body, headers };
}

function error(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): SellerResponse {
  return json(status, { code, message, details });
}

/**
 * The x402 resource server for agent services (mounted at POST /services/:id/invoke).
 *
 *   no PAYMENT-SIGNATURE → create a quoted invocation, answer 402 PaymentRequired
 *   PAYMENT-SIGNATURE    → look the invoice up, reject replays for other purchases, verify and
 *                          settle through the facilitator with the STORED requirements, prove
 *                          the settlement on the ledger, move the invocation quoted → paid
 *                          atomically, execute the service once, answer 200 + PAYMENT-RESPONSE.
 *
 * A duplicate receipt for an already-settled invoice is idempotent: the stored result is
 * returned and nothing is settled or executed again. No payment, no service.
 */
export class SellerGate {
  private readonly run: ServiceExecutor;

  constructor(private readonly deps: SellerGateDeps) {
    this.run = deps.executeService ?? executeService;
  }

  async handle(request: SellerRequest): Promise<SellerResponse> {
    try {
      const service = await this.deps.store.getService(request.serviceId);
      if (!service) return error(404, "NOT_FOUND", `service ${request.serviceId} not found`);
      if (service.status !== "active")
        return error(410, "NOT_FOUND", `service ${service.id} is ${service.status}`);
      const body = invokeBodySchema.safeParse(request.body ?? {});
      if (!body.success) return error(400, "VALIDATION_FAILED", "body must be { input: object }");
      const tick = await this.tick(body.data.tick);
      if (!request.paymentHeader)
        return await this.quote(service, body.data.input, request.resourceUrl, tick);
      return await this.paid(service, request.paymentHeader, request.resourceUrl, tick);
    } catch (e) {
      if (isAigentiaError(e)) {
        const status =
          e.code === "X402_MALFORMED" || e.code === "VALIDATION_FAILED"
            ? 400
            : e.code === "CONFLICT"
              ? 409
              : 502;
        return error(status, e.code, e.message, e.details ?? {});
      }
      this.deps.logger?.error({ error: errorMessage(e) }, "seller gate failed");
      return error(500, "INTERNAL", "seller failed");
    }
  }

  /**
   * Tick label for events. `currentTick` is the last finished tick, so a buyer acting inside a
   * running tick reports currentTick + 1; anything else falls back to the stored value.
   */
  private async tick(claimed?: number): Promise<number> {
    const current = (await this.deps.store.getSimulationState()).currentTick;
    return claimed === current || claimed === current + 1 ? claimed : current;
  }

  private async quote(
    service: ServiceRecord,
    input: Record<string, unknown>,
    resourceUrl: string,
    tick: number,
  ): Promise<SellerResponse> {
    const { store, ids, clock, events } = this.deps;
    const inputError = serviceInputError(service.kind, input);
    if (inputError)
      return error(400, "VALIDATION_FAILED", `invalid ${service.kind} input: ${inputError}`);
    const seller = await store.getAgent(service.sellerAgentId);
    if (!seller || seller.status !== "active")
      return error(410, "NOT_FOUND", "seller is not active");
    const now = clock();
    const invoiceId = ids.next("invocation", `x402:${service.id}:${tick}`);
    const required = buildPaymentRequired({
      resourceUrl,
      description: `${service.kind} ${SERVICE_KIND_CATEGORY[service.kind]} by ${seller.name}`,
      network: this.deps.network,
      payTo: seller.walletAddress,
      amountDrops: service.priceDrops,
      invoiceId,
      sourceTag: this.deps.sourceTag,
      maxTimeoutSeconds: this.deps.maxTimeoutSeconds,
    });
    const requirement = required.accepts[0];
    if (!requirement) throw new AigentiaError("INTERNAL", "no payment requirement built");
    await store.createInvocation({
      id: invoiceId,
      serviceId: service.id,
      sellerAgentId: seller.id,
      buyerAgentId: null,
      buyerAddress: null,
      invoiceId,
      priceDrops: service.priceDrops,
      paymentRequirements: requirement as unknown as Record<string, unknown>,
      request: input,
      tick,
      expiresAt: new Date(now.getTime() + this.deps.maxTimeoutSeconds * 1000),
      createdAt: now,
    });
    await events.emitOne({
      tick,
      at: now,
      type: "SERVICE_QUOTED",
      agentId: seller.id,
      amountDrops: service.priceDrops,
      message: `${seller.name} quoted ${service.kind} at ${fmtXrp(service.priceDrops)} (HTTP 402)`,
      payload: { invocationId: invoiceId, serviceId: service.id },
    });
    return json(402, required as unknown as Record<string, unknown>);
  }

  private replay(invocation: InvocationRecord): SellerResponse {
    const settlement: X402SettlementResponse = {
      success: true,
      transaction: invocation.txHash ?? "",
      network: this.deps.network,
      payer: invocation.buyerAddress,
    };
    const headers = { [PAYMENT_RESPONSE]: encodePaymentResponse(settlement) };
    if (invocation.status === "fulfilled") {
      return json(
        200,
        { invocationId: invocation.id, output: invocation.response ?? {}, replayed: true },
        headers,
      );
    }
    if (invocation.status === "failed") {
      return json(
        500,
        {
          invocationId: invocation.id,
          code: "SERVICE_FAILED",
          message: invocation.error ?? "service failed",
          replayed: true,
        },
        headers,
      );
    }
    return error(409, "CONFLICT", "payment for this invoice is being settled", {
      invocationId: invocation.id,
    });
  }

  private async paid(
    service: ServiceRecord,
    header: string,
    resourceUrl: string,
    tick: number,
  ): Promise<SellerResponse> {
    const { store, facilitator, verifier } = this.deps;
    const payload: X402PaymentPayload = decodePaymentSignature(header);
    const invocation = await store.getInvocationByInvoice(payload.payload.invoiceId);
    if (!invocation || invocation.serviceId !== service.id) {
      return error(400, "X402_UNTRUSTED", "unknown invoice for this service");
    }
    const decoded = decodePresigned(payload.payload.signedTxBlob);
    if (!decoded) return error(400, "X402_MALFORMED", "undecodable signed transaction");
    const txHash = decoded.hash;

    // Idempotency: the same receipt again returns the stored outcome, nothing re-runs.
    if (invocation.txHash !== null) {
      if (invocation.txHash === txHash) return this.replay(invocation);
      return error(409, "CONFLICT", "invoice already settled by another transaction");
    }
    // One transaction settles one purchase.
    const reused = await store.getInvocationByTxHash(txHash);
    if (reused && reused.id !== invocation.id) {
      return error(409, "CONFLICT", "transaction already settled another purchase", { txHash });
    }
    if (invocation.status !== "quoted") {
      return error(409, "CONFLICT", `invocation is ${invocation.status}`);
    }
    const now = this.deps.clock();
    if (invocation.expiresAt.getTime() < now.getTime()) {
      await store.transitionInvocation(invocation.id, "quoted", {
        status: "expired",
        error: "quote expired",
      });
      const fresh = await this.quote(service, invocation.request, resourceUrl, tick);
      return { ...fresh, body: { ...fresh.body, error: "quote_expired" } };
    }
    const requirements: X402PaymentRequirements = x402PaymentRequirementsSchema.parse(
      invocation.paymentRequirements,
    );

    // The payer must be an agent of this world: resolved offline, BEFORE any money moves.
    const payerAddress = typeof decoded.tx["Account"] === "string" ? decoded.tx["Account"] : "";
    const buyer = await store.getAgentByAddress(payerAddress);
    if (!buyer) return error(403, "UNAUTHORIZED", "payer is not a registered agent");
    if (buyer.id === service.sellerAgentId)
      return error(400, "VALIDATION_FAILED", "an agent cannot buy its own service");

    const verdict = await facilitator.verify(payload, requirements);
    if (!verdict.isValid) {
      await store.updateInvocation(invocation.id, {
        error: `verify: ${verdict.invalidReason ?? "invalid"}`,
      });
      return json(402, {
        error: verdict.invalidReason ?? "invalid_payment",
        invocationId: invocation.id,
      });
    }
    const settlement = await facilitator.settle(payload, requirements);
    if (!settlement.success) {
      await store.updateInvocation(invocation.id, {
        error: `settle: ${settlement.errorReason ?? "failed"}`,
      });
      return json(402, {
        error: settlement.errorReason ?? "settlement_failed",
        invocationId: invocation.id,
      });
    }
    if (settlement.transaction.toUpperCase() !== txHash.toUpperCase()) {
      return error(502, "X402_UNTRUSTED", "facilitator settled a different transaction");
    }
    await verifier.verify(txHash, {
      destination: requirements.payTo,
      amountDrops: BigInt(requirements.amount),
      asset: XRP,
      sender: buyer.walletAddress,
      invoiceId: invocation.invoiceId,
    });

    const claimed = await store.transitionInvocation(invocation.id, "quoted", {
      status: "paid",
      txHash,
      buyerAgentId: buyer.id,
      buyerAddress: buyer.walletAddress,
      error: null,
    });
    if (!claimed) {
      const current = await store.getInvocation(invocation.id);
      return current && current.txHash === txHash
        ? this.replay(current)
        : error(409, "CONFLICT", "invocation changed concurrently");
    }
    return this.fulfil(service, claimed, buyer.id, settlement, tick);
  }

  private async fulfil(
    service: ServiceRecord,
    invocation: InvocationRecord,
    buyerAgentId: string,
    settlement: X402SettlementResponse,
    tick: number,
  ): Promise<SellerResponse> {
    const { store, events, ids, clock } = this.deps;
    const now = clock();
    const scope = `x402:${invocation.id}`;
    const seller = await store.getAgent(service.sellerAgentId);
    const buyer = await store.getAgent(buyerAgentId);
    const sellerName = seller?.name ?? service.sellerAgentId;
    const buyerName = buyer?.name ?? buyerAgentId;
    const category = SERVICE_KIND_CATEGORY[service.kind];
    const headers = { [PAYMENT_RESPONSE]: encodePaymentResponse(settlement) };
    const reputationCtx = {
      tick,
      at: now,
      ids,
      scope,
      refKind: "invocation",
      refId: invocation.id,
    };
    const started = Date.now();
    try {
      const raw = await this.run(service.kind, invocation.request, {
        store,
        tick,
        sellerAgentId: service.sellerAgentId,
        buyerAgentId,
        nextInventoryId: () => ids.next("inventory", scope),
      });
      const output = validateServiceOutput(service.kind, raw) as unknown as Record<string, unknown>;
      const latencyMs = Math.max(0, Date.now() - started);
      await store.updateInvocation(invocation.id, {
        status: "fulfilled",
        response: output,
        latencyMs,
      });
      await store.recordServiceCall(service.id, {
        success: true,
        latencyMs,
        revenueDrops: service.priceDrops,
        at: now,
      });
      await applyAgentReputation(
        store,
        service.sellerAgentId,
        "SERVICE_SUCCESS_SELLER",
        reputationCtx,
      );
      await events.emitOne({
        tick,
        at: now,
        type: "SERVICE_FULFILLED",
        agentId: service.sellerAgentId,
        counterpartyId: buyerAgentId,
        txHash: settlement.transaction,
        amountDrops: service.priceDrops,
        message: `${sellerName} delivered ${service.kind} ${category} to ${buyerName} over x402 and earned ${fmtXrp(service.priceDrops)}`,
        payload: { invocationId: invocation.id, serviceId: service.id },
      });
      return json(200, { invocationId: invocation.id, output }, headers);
    } catch (e) {
      const message = errorMessage(e);
      const latencyMs = Math.max(0, Date.now() - started);
      await store.updateInvocation(invocation.id, { status: "failed", error: message, latencyMs });
      await store.recordServiceCall(service.id, {
        success: false,
        latencyMs,
        revenueDrops: service.priceDrops,
        at: now,
      });
      await applyAgentReputation(
        store,
        service.sellerAgentId,
        "SERVICE_FAILED_SELLER",
        reputationCtx,
      );
      await events.emitOne({
        tick,
        at: now,
        type: "SERVICE_FAILED",
        agentId: service.sellerAgentId,
        counterpartyId: buyerAgentId,
        txHash: settlement.transaction,
        message: `${sellerName} was paid for ${service.kind} but failed to deliver to ${buyerName}: ${message}`,
        payload: { invocationId: invocation.id, serviceId: service.id },
      });
      return json(500, { invocationId: invocation.id, code: "SERVICE_FAILED", message }, headers);
    }
  }
}
