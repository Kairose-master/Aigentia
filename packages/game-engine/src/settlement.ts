import {
  createPaymentIntent,
  intentAmountDrops,
  spentInWindows,
  type PaymentAdapter,
  type PolicyEngine,
  type SpendTracker,
} from "@aigentia/economy";
import type {
  BudgetPolicy,
  PaymentIntent,
  PaymentReceipt,
  PolicyDecision,
} from "@aigentia/protocol";
import {
  AigentiaError,
  SERVICE_KIND_CATEGORY,
  errorMessage,
  isAigentiaError,
  type Logger,
} from "@aigentia/shared";
import type { BalanceSource, Clock, TreasuryInfo } from "./context";
import type { EventLog } from "./events";
import type { IdGenerator } from "./ids";
import { applyAgentReputation } from "./reputation";
import {
  executeService,
  serviceInputError,
  validateServiceOutput,
  type ServiceExecutor,
} from "./services";
import type { AgentRecord, ServiceRecord, WorldStore } from "./store/types";
import { TREASURY_AGENT_ID, TREASURY_BUDGET_POLICY, TREASURY_NAME, fmtXrp } from "./world";

/** Whoever signs a payment: an agent row, or the treasury pseudo-agent. */
export interface Payer {
  readonly id: string;
  readonly name: string;
  readonly walletRef: string;
  readonly walletAddress: string;
  readonly budgetPolicy: BudgetPolicy;
}

export function treasuryPayer(treasury: TreasuryInfo): Payer {
  return {
    id: TREASURY_AGENT_ID,
    name: TREASURY_NAME,
    walletRef: treasury.walletRef,
    walletAddress: treasury.address,
    budgetPolicy: TREASURY_BUDGET_POLICY,
  };
}

export function isTreasuryPayer(payer: Pick<Payer, "id">): boolean {
  return payer.id === TREASURY_AGENT_ID;
}

export interface PayContext {
  /** The paying agent (an AgentRecord satisfies this) or `treasuryPayer(...)`. */
  readonly agent: Payer;
  readonly tick: number;
  readonly invoiceId?: string;
  readonly memo?: string;
  /** Id scope for the payment row; defaults to `${tick}:${agent.id}`. */
  readonly scope?: string;
  /** Tail for the spectator line, e.g. "for SCOUT intelligence". */
  readonly description?: string;
  /**
   * Adapter for this one payment (the x402 purchaser settles through the seller's
   * facilitator instead of submitting directly). Must settle on the same ledger.
   */
  readonly adapter?: PaymentAdapter;
}

export interface PaymentOutcome {
  readonly status: "validated" | "denied" | "failed";
  readonly paymentId: string;
  readonly intentId: string;
  readonly amountDrops: bigint;
  readonly decision: PolicyDecision;
  readonly receipt?: PaymentReceipt;
  readonly txHash?: string;
  readonly error?: string;
}

export interface SettlementDeps {
  readonly store: WorldStore;
  readonly adapter: PaymentAdapter;
  readonly policyEngine: PolicyEngine;
  readonly spendTracker: SpendTracker;
  readonly balances: BalanceSource;
  readonly events: EventLog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly treasury: TreasuryInfo;
  readonly logger?: Logger;
}

interface Receiver {
  readonly agent: AgentRecord | null;
  readonly name: string;
}

/**
 * The single path from a PaymentIntent to money moving:
 *   PolicyEngine (live balance + rolling spend) → payments row → PaymentAdapter → receipt.
 * Records intent and payment rows in every outcome, emits PAYMENT_* events, refreshes the
 * cached balances of both parties and applies the buyer-side reputation penalties.
 */
export class Settlement {
  constructor(private readonly deps: SettlementDeps) {}

  get ledger(): PaymentAdapter["ledger"] {
    return this.deps.adapter.ledger;
  }

  private async receiverOf(intent: PaymentIntent): Promise<Receiver> {
    const { store, treasury } = this.deps;
    if (intent.destinationAgentId !== null) {
      const agent = await store.getAgent(intent.destinationAgentId);
      if (agent) return { agent, name: agent.name };
    }
    if (intent.destinationAddress === treasury.address) return { agent: null, name: "the market" };
    return { agent: null, name: intent.destinationAddress };
  }

  private async refreshBalance(
    agent: Pick<AgentRecord, "id" | "walletAddress"> | null,
  ): Promise<void> {
    if (!agent) return;
    const { store, balances, clock } = this.deps;
    const snapshot = await balances.getBalanceDrops(agent.walletAddress);
    await store.updateAgent(agent.id, {
      balanceDrops: snapshot.balanceDrops,
      balanceCheckedAt: clock(),
    });
  }

  async pay(intent: PaymentIntent, ctx: PayContext): Promise<PaymentOutcome> {
    const { store, policyEngine, spendTracker, balances, events, ids, clock } = this.deps;
    const adapter = ctx.adapter ?? this.deps.adapter;
    if (adapter.ledger !== this.deps.adapter.ledger) {
      throw new AigentiaError(
        "VALIDATION_FAILED",
        "payment adapter settles on a different ledger",
        {
          expected: this.deps.adapter.ledger,
          actual: adapter.ledger,
        },
      );
    }
    const payer = ctx.agent;
    const fromTreasury = isTreasuryPayer(payer);
    const now = clock();
    const scope = ctx.scope ?? `${ctx.tick}:${payer.id}`;
    const amount = intentAmountDrops(intent);
    const tail = ctx.description ? ` ${ctx.description}` : "";

    const [balance, spent, receiver] = await Promise.all([
      balances.getBalanceDrops(payer.walletAddress),
      spentInWindows(spendTracker, payer.id, now),
      this.receiverOf(intent),
    ]);
    const decision = policyEngine.evaluate(intent, {
      policy: payer.budgetPolicy,
      balanceDrops: balance.balanceDrops,
      reserveDrops: balance.reserveDrops,
      ...spent,
      ownAddress: payer.walletAddress,
      now,
    });

    // The treasury is not an agent row, so its intents cannot satisfy the FK and are not stored.
    if (!fromTreasury) {
      await store.recordPaymentIntent({
        id: intent.id,
        agentId: intent.agentId,
        purpose: intent.purpose,
        destinationAddress: intent.destinationAddress,
        destinationAgentId: intent.destinationAgentId,
        asset: intent.asset.code,
        amountDrops: amount,
        serviceCategory: intent.serviceCategory,
        actionKind: intent.actionRef.kind,
        actionId: intent.actionRef.id,
        approved: decision.approved,
        policyDecision: decision as unknown as Record<string, unknown>,
        tick: ctx.tick,
        createdAt: now,
      });
    }

    const paymentId = ids.next("payment", scope);
    const row = {
      id: paymentId,
      intentId: fromTreasury ? null : intent.id,
      kind: intent.purpose,
      ledger: adapter.ledger,
      senderAgentId: fromTreasury ? null : payer.id,
      receiverAgentId: receiver.agent?.id ?? null,
      senderAddress: payer.walletAddress,
      receiverAddress: intent.destinationAddress,
      asset: intent.asset.code,
      amountDrops: amount,
      invoiceId: ctx.invoiceId ?? null,
      actionKind: intent.actionRef.kind,
      actionId: intent.actionRef.id,
      tick: ctx.tick,
      createdAt: now,
    };
    const base = {
      tick: ctx.tick,
      at: now,
      agentId: fromTreasury ? null : payer.id,
      counterpartyId: receiver.agent?.id ?? null,
      amountDrops: amount,
    };

    if (!decision.approved) {
      const rules = decision.violations.map((v) => v.rule).join(", ");
      await store.recordPayment({ ...row, status: "denied", error: rules });
      await events.emitOne({
        ...base,
        type: "PAYMENT_DENIED",
        message: `${payer.name} was denied paying ${receiver.name} ${fmtXrp(amount)}${tail} (${rules})`,
        payload: { paymentId, intentId: intent.id, violations: decision.violations },
      });
      if (!fromTreasury) {
        await applyAgentReputation(store, payer.id, "PAYMENT_DENIED_BUYER", {
          tick: ctx.tick,
          at: now,
          ids,
          scope,
          refKind: "payment",
          refId: paymentId,
        });
      }
      this.deps.logger?.info({ intentId: intent.id, rules }, "payment denied by policy");
      return { status: "denied", paymentId, intentId: intent.id, amountDrops: amount, decision };
    }

    await store.recordPayment({ ...row, status: "submitted" });
    await events.emitOne({
      ...base,
      type: "PAYMENT_SUBMITTED",
      message: `${payer.name} is paying ${receiver.name} ${fmtXrp(amount)}${tail}`,
      payload: { paymentId, intentId: intent.id, purpose: intent.purpose },
    });

    try {
      const receipt = await adapter.execute(intent, {
        walletRef: payer.walletRef,
        tick: ctx.tick,
        paymentId,
        ...(ctx.invoiceId !== undefined ? { invoiceId: ctx.invoiceId } : {}),
        ...(ctx.memo !== undefined ? { memo: ctx.memo } : {}),
      });
      await store.updatePayment(paymentId, {
        status: "validated",
        txHash: receipt.txHash,
        ledgerIndex: receipt.ledgerIndex,
        validatedAt: new Date(receipt.validatedAt),
      });
      await spendTracker.record(payer.id, amount, now);
      await this.refreshBalance(
        fromTreasury ? null : { id: payer.id, walletAddress: payer.walletAddress },
      );
      await this.refreshBalance(receiver.agent);
      await events.emitOne({
        ...base,
        type: "PAYMENT_VALIDATED",
        txHash: receipt.txHash,
        message: `${payer.name} paid ${receiver.name} ${fmtXrp(amount)}${tail} (validated on ${receipt.ledger})`,
        payload: { paymentId, intentId: intent.id, ledgerIndex: receipt.ledgerIndex },
      });
      return {
        status: "validated",
        paymentId,
        intentId: intent.id,
        amountDrops: amount,
        decision,
        receipt,
        txHash: receipt.txHash,
      };
    } catch (e) {
      const error = errorMessage(e);
      const txHash = isAigentiaError(e) ? e.details?.["txHash"] : undefined;
      const hash = typeof txHash === "string" ? txHash : undefined;
      try {
        await store.updatePayment(paymentId, {
          status: "failed",
          error,
          ...(hash !== undefined ? { txHash: hash } : {}),
        });
      } catch (inner) {
        // A duplicate hash on a failed row must never mask the settlement failure itself.
        await store.updatePayment(paymentId, {
          status: "failed",
          error: `${error}; ${errorMessage(inner)}`,
        });
      }
      await this.refreshBalance(
        fromTreasury ? null : { id: payer.id, walletAddress: payer.walletAddress },
      );
      await this.refreshBalance(receiver.agent);
      await events.emitOne({
        ...base,
        type: "PAYMENT_FAILED",
        txHash: hash ?? null,
        message: `${payer.name}'s payment of ${fmtXrp(amount)} to ${receiver.name}${tail} failed: ${error}`,
        payload: { paymentId, intentId: intent.id, error },
      });
      if (!fromTreasury) {
        await applyAgentReputation(store, payer.id, "PAYMENT_FAILED_BUYER", {
          tick: ctx.tick,
          at: now,
          ids,
          scope,
          refKind: "payment",
          refId: paymentId,
        });
      }
      this.deps.logger?.warn({ intentId: intent.id, error }, "payment failed");
      return {
        status: "failed",
        paymentId,
        intentId: intent.id,
        amountDrops: amount,
        decision,
        error,
        ...(hash !== undefined ? { txHash: hash } : {}),
      };
    }
  }
}

// ── service purchases ─────────────────────────────────────────────────────────

export type PurchaseStatus =
  | "fulfilled"
  /** Input or price check failed before any payment. */
  | "rejected"
  /** PolicyEngine denied the payment. */
  | "denied"
  /** Payment approved but did not settle. */
  | "payment_failed"
  /** Paid, but the service threw or returned invalid output. */
  | "service_failed";

export interface PurchaseParams {
  readonly buyer: AgentRecord;
  readonly service: ServiceRecord;
  readonly input: unknown;
  readonly maxPriceDrops: bigint;
  readonly tick: number;
  readonly scope?: string;
}

export interface PurchaseResult {
  readonly status: PurchaseStatus;
  readonly invocationId: string;
  readonly invoiceId: string;
  readonly priceDrops: bigint;
  readonly sellerAgentId: string;
  readonly sellerName: string;
  readonly paymentId?: string;
  readonly txHash?: string;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
  readonly decision?: PolicyDecision;
}

/** Buys a service for an agent. In-process now; the HTTP x402 purchaser implements this in Phase 3. */
export interface ServicePurchaser {
  purchase(params: PurchaseParams): Promise<PurchaseResult>;
}

export interface InProcessServicePurchaserDeps {
  readonly store: WorldStore;
  readonly settlement: Settlement;
  readonly events: EventLog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** CAIP-2 network stamped on the quote (xrpl:1 testnet). */
  readonly network?: string;
  /** How long a quote stays payable. */
  readonly quoteTtlMs?: number;
  /** Override to inject faults in tests; defaults to `executeService`. */
  readonly executeService?: ServiceExecutor;
}

/**
 * Quote → pay through Settlement (purpose "x402", invoice bound to the payment) → only
 * once the payment is validated, execute the service, validate its output and mark the
 * invocation fulfilled. A denied or failed payment never runs the service.
 */
export class InProcessServicePurchaser implements ServicePurchaser {
  private readonly run: ServiceExecutor;

  constructor(private readonly deps: InProcessServicePurchaserDeps) {
    this.run = deps.executeService ?? executeService;
  }

  async purchase(params: PurchaseParams): Promise<PurchaseResult> {
    const { store, settlement, events, ids, clock } = this.deps;
    const { buyer, service, tick } = params;
    const scope = params.scope ?? `${tick}:${buyer.id}`;
    const now = clock();
    const seller = await store.getAgent(service.sellerAgentId);
    if (!seller) {
      throw new AigentiaError("NOT_FOUND", `seller ${service.sellerAgentId} not found`, {
        serviceId: service.id,
      });
    }
    const invocationId = ids.next("invocation", scope);
    const invoiceId = invocationId;
    const category = SERVICE_KIND_CATEGORY[service.kind];
    const request =
      params.input !== null && typeof params.input === "object" && !Array.isArray(params.input)
        ? (params.input as Record<string, unknown>)
        : { input: params.input };
    const invocation = await store.createInvocation({
      id: invocationId,
      serviceId: service.id,
      sellerAgentId: seller.id,
      buyerAgentId: buyer.id,
      buyerAddress: buyer.walletAddress,
      invoiceId,
      priceDrops: service.priceDrops,
      paymentRequirements: {
        scheme: "exact",
        network: this.deps.network ?? "xrpl:1",
        asset: "XRP",
        amount: service.priceDrops.toString(),
        payTo: seller.walletAddress,
        invoiceId,
        maxTimeoutSeconds: Math.round((this.deps.quoteTtlMs ?? 120_000) / 1000),
      },
      request,
      tick,
      expiresAt: new Date(now.getTime() + (this.deps.quoteTtlMs ?? 120_000)),
      createdAt: now,
    });
    const common = {
      invocationId: invocation.id,
      invoiceId,
      priceDrops: service.priceDrops,
      sellerAgentId: seller.id,
      sellerName: seller.name,
    };

    if (service.priceDrops > params.maxPriceDrops) {
      const error = `price ${service.priceDrops} drops exceeds the ceiling of ${params.maxPriceDrops} drops`;
      await store.updateInvocation(invocation.id, { status: "rejected", error });
      return { ...common, status: "rejected", error };
    }
    const inputError = serviceInputError(service.kind, params.input);
    if (inputError) {
      await store.updateInvocation(invocation.id, { status: "rejected", error: inputError });
      return { ...common, status: "rejected", error: inputError };
    }

    const intent = createPaymentIntent({
      id: ids.next("intent", scope),
      agentId: buyer.id,
      purpose: "x402",
      destinationAddress: seller.walletAddress,
      destinationAgentId: seller.id,
      amount: service.priceDrops,
      serviceCategory: category,
      actionRef: { kind: "invocation", id: invocation.id },
      memo: `x402 ${service.kind} ${invoiceId}`.slice(0, 200),
      createdAt: now.toISOString(),
    });
    const outcome = await settlement.pay(intent, {
      agent: buyer,
      tick,
      invoiceId,
      scope,
      description: `for ${service.kind} ${category}`,
    });

    if (outcome.status === "denied") {
      const error = `payment denied: ${outcome.decision.violations.map((v) => v.rule).join(", ")}`;
      await store.updateInvocation(invocation.id, {
        status: "rejected",
        paymentId: outcome.paymentId,
        error,
      });
      return {
        ...common,
        status: "denied",
        paymentId: outcome.paymentId,
        error,
        decision: outcome.decision,
      };
    }
    if (outcome.status === "failed") {
      const error = `payment failed: ${outcome.error ?? "unknown"}`;
      await store.updateInvocation(invocation.id, {
        status: "failed",
        paymentId: outcome.paymentId,
        ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
        error,
      });
      return {
        ...common,
        status: "payment_failed",
        paymentId: outcome.paymentId,
        ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
        error,
        decision: outcome.decision,
      };
    }

    const txHash = outcome.txHash ?? null;
    await store.updateInvocation(invocation.id, {
      status: "paid",
      paymentId: outcome.paymentId,
      txHash,
    });
    await events.emitOne({
      tick,
      at: now,
      type: "SERVICE_PURCHASED",
      agentId: buyer.id,
      counterpartyId: seller.id,
      txHash,
      amountDrops: service.priceDrops,
      message: `${buyer.name} paid ${seller.name} ${fmtXrp(service.priceDrops)} for ${service.kind} ${category}`,
      payload: { invocationId: invocation.id, serviceId: service.id, paymentId: outcome.paymentId },
    });

    const started = clock().getTime();
    const reputationCtx = {
      tick,
      at: now,
      ids,
      scope,
      refKind: "invocation",
      refId: invocation.id,
    };
    try {
      const raw = await this.run(service.kind, params.input, {
        store,
        tick,
        sellerAgentId: seller.id,
        buyerAgentId: buyer.id,
        nextInventoryId: () => ids.next("inventory", scope),
      });
      const output = validateServiceOutput(service.kind, raw) as unknown as Record<string, unknown>;
      const latencyMs = Math.max(0, clock().getTime() - started);
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
      await applyAgentReputation(store, seller.id, "SERVICE_SUCCESS_SELLER", reputationCtx);
      await applyAgentReputation(store, buyer.id, "SERVICE_SUCCESS_BUYER", reputationCtx);
      await events.emitOne({
        tick,
        at: now,
        type: "SERVICE_FULFILLED",
        agentId: seller.id,
        counterpartyId: buyer.id,
        txHash,
        amountDrops: service.priceDrops,
        message: `${seller.name} delivered ${service.kind} ${category} to ${buyer.name}`,
        payload: { invocationId: invocation.id, serviceId: service.id },
      });
      return {
        ...common,
        status: "fulfilled",
        paymentId: outcome.paymentId,
        ...(txHash !== null ? { txHash } : {}),
        output,
        decision: outcome.decision,
      };
    } catch (e) {
      const error = errorMessage(e);
      const latencyMs = Math.max(0, clock().getTime() - started);
      await store.updateInvocation(invocation.id, { status: "failed", error, latencyMs });
      await store.recordServiceCall(service.id, {
        success: false,
        latencyMs,
        revenueDrops: service.priceDrops,
        at: now,
      });
      await applyAgentReputation(store, seller.id, "SERVICE_FAILED_SELLER", reputationCtx);
      await events.emitOne({
        tick,
        at: now,
        type: "SERVICE_FAILED",
        agentId: seller.id,
        counterpartyId: buyer.id,
        txHash,
        amountDrops: service.priceDrops,
        message: `${seller.name} failed to deliver ${service.kind} ${category} to ${buyer.name}: ${error}`,
        payload: { invocationId: invocation.id, serviceId: service.id, error },
      });
      return {
        ...common,
        status: "service_failed",
        paymentId: outcome.paymentId,
        ...(txHash !== null ? { txHash } : {}),
        error,
        decision: outcome.decision,
      };
    }
  }
}
