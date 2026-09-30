import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  agentSnapshots,
  agents,
  decisions,
  inventoryItems,
  jobs,
  locations,
  marketPrices,
  paymentIntents,
  payments,
  reputationEvents,
  resourceListings,
  resources,
  serviceInvocations,
  services,
  simulationState,
  ticks,
  trades,
  worldEvents,
  type Database,
} from "@aigentia/db";
import {
  AigentiaError,
  errorMessage,
  type InvocationStatus,
  type ResourceType,
} from "@aigentia/shared";
import { worldEventSchema, type WorldEvent, type WorldEventInput } from "@aigentia/protocol";
import type { GenesisWorld } from "../world";
import { knowledgeFromStrategy, knowledgeToJson, mergeKnowledge } from "./knowledge";
import type {
  AgentFilter,
  AgentPatch,
  AgentRecord,
  AgentSnapshotInput,
  AgentSnapshotRecord,
  BeginTickInput,
  DecisionPatch,
  DecisionRecord,
  EventFilter,
  FinishTickInput,
  InventoryItemRecord,
  InvocationPatch,
  InvocationRecord,
  JobRecord,
  KnowledgeEntry,
  ListingFilter,
  ListingRecord,
  LocationRecord,
  MarketPriceInput,
  MarketPriceRecord,
  NewAgentInput,
  NewDecisionInput,
  NewInvocationInput,
  NewJobInput,
  NewListingInput,
  NewPaymentInput,
  NewPaymentIntentInput,
  NewTradeInput,
  PaymentIntentRecord,
  PaymentPatch,
  PaymentRecord,
  ReputationEventInput,
  ReputationEventRecord,
  ResourceRecord,
  ServiceCallInput,
  ServiceFilter,
  ServiceRecord,
  SimulationStatePatch,
  SimulationStateRecord,
  TradeFilter,
  TradeRecord,
  UpsertServiceInput,
  WorldStore,
} from "./types";

const PG_UNIQUE_VIOLATION = "23505";

function pgCode(e: unknown): string | null {
  if (e && typeof e === "object") {
    const rec = e as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string") return rec.code;
    if (rec.cause && typeof rec.cause === "object") {
      const cause = rec.cause as { code?: unknown };
      if (typeof cause.code === "string") return cause.code;
    }
  }
  return null;
}

/** Translate a unique-index violation into the CONFLICT the store contract promises. */
function asConflict(e: unknown, message: string, details: Record<string, unknown>): never {
  if (pgCode(e) === PG_UNIQUE_VIOLATION) {
    throw new AigentiaError("CONFLICT", message, { ...details, cause: errorMessage(e) });
  }
  throw e;
}

function notFound(what: string, id: string): AigentiaError {
  return new AigentiaError("NOT_FOUND", `${what} ${id} not found`, { id });
}

function first<T>(rows: T[], what: string, id: string): T {
  const row = rows[0];
  if (row === undefined) throw notFound(what, id);
  return row;
}

function toWorldEvent(row: typeof worldEvents.$inferSelect): WorldEvent {
  return worldEventSchema.parse({
    id: row.id,
    tick: row.tick,
    type: row.type,
    message: row.message,
    agentId: row.agentId,
    counterpartyId: row.counterpartyId,
    experimentId: row.experimentId,
    txHash: row.txHash,
    amountDrops: row.amountDrops === null ? null : row.amountDrops.toString(),
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  });
}

function defined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * WorldStore on PostgreSQL through drizzle. Money columns are `mode: "bigint"`, atomic
 * transitions (claimJob, fillListing, adjustInventory) are single guarded UPDATEs, and the
 * unique indexes on payments enforce "one tx hash / one invoice settles one payment".
 * `transaction()` runs the callback against a store bound to the transaction handle.
 */
export class PostgresWorldStore implements WorldStore {
  constructor(private readonly db: Database) {}

  // ── world ───────────────────────────────────────────────────────────────────

  async seedWorld(world: GenesisWorld): Promise<void> {
    await this.db
      .insert(locations)
      .values(world.locations.map((l) => ({ ...l })))
      .onConflictDoNothing();
    if (world.resources.length > 0) {
      await this.db
        .insert(resources)
        .values(world.resources.map((r) => ({ ...r })))
        .onConflictDoNothing();
    }
    await this.db
      .insert(marketPrices)
      .values(world.marketPrices.map((m) => ({ ...m, lastTick: 0, history: [] })))
      .onConflictDoNothing();
    await this.db.insert(simulationState).values({ id: 1, seed: world.seed }).onConflictDoNothing();
  }

  async getSimulationState(): Promise<SimulationStateRecord> {
    const rows = await this.db.select().from(simulationState).where(eq(simulationState.id, 1));
    return first(rows, "simulation_state", "1");
  }

  async setSimulationState(patch: SimulationStatePatch): Promise<SimulationStateRecord> {
    const rows = await this.db
      .update(simulationState)
      .set({ ...defined({ ...patch }), updatedAt: new Date() })
      .where(eq(simulationState.id, 1))
      .returning();
    return first(rows, "simulation_state", "1");
  }

  async beginTick(input: BeginTickInput): Promise<void> {
    await this.db
      .insert(ticks)
      .values({ tick: input.tick, seed: input.seed, startedAt: input.startedAt })
      .onConflictDoUpdate({
        target: ticks.tick,
        set: {
          seed: input.seed,
          startedAt: input.startedAt,
          finishedAt: null,
          status: "running",
          error: null,
        },
      });
  }

  async finishTick(input: FinishTickInput): Promise<void> {
    await this.db
      .update(ticks)
      .set({
        finishedAt: input.finishedAt,
        agentsProcessed: input.agentsProcessed,
        status: input.status,
        error: input.error ?? null,
      })
      .where(eq(ticks.tick, input.tick));
  }

  async listLocations(): Promise<LocationRecord[]> {
    return this.db.select().from(locations).orderBy(asc(locations.id));
  }

  async listResources(): Promise<ResourceRecord[]> {
    return this.db.select().from(resources).orderBy(asc(resources.id));
  }

  async updateResource(id: string, patch: { quantity: number }): Promise<ResourceRecord> {
    const rows = await this.db
      .update(resources)
      .set({ quantity: patch.quantity, updatedAt: new Date() })
      .where(eq(resources.id, id))
      .returning();
    return first(rows, "resource", id);
  }

  async getMarketPrices(): Promise<MarketPriceRecord[]> {
    return this.db.select().from(marketPrices).orderBy(asc(marketPrices.resourceType));
  }

  async setMarketPrice(input: MarketPriceInput): Promise<MarketPriceRecord> {
    const values = {
      resourceType: input.resourceType,
      bidDrops: input.bidDrops,
      askDrops: input.askDrops,
      supply: input.supply,
      lastTick: input.lastTick,
      history: input.history.map((h) => ({ ...h })),
    };
    const rows = await this.db
      .insert(marketPrices)
      .values(values)
      .onConflictDoUpdate({ target: marketPrices.resourceType, set: values })
      .returning();
    return first(rows, "market_price", input.resourceType);
  }

  // ── agents ──────────────────────────────────────────────────────────────────

  async listAgents(filter: AgentFilter = {}): Promise<AgentRecord[]> {
    const conditions = [];
    if (filter.status !== undefined) conditions.push(eq(agents.status, filter.status));
    if (filter.experimentId !== undefined) {
      conditions.push(
        filter.experimentId === null
          ? sql`${agents.experimentId} is null`
          : eq(agents.experimentId, filter.experimentId),
      );
    }
    return this.db
      .select()
      .from(agents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(agents.id));
  }

  async listActiveAgents(): Promise<AgentRecord[]> {
    return this.listAgents({ status: "active" });
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getAgentByName(name: string): Promise<AgentRecord | null> {
    const rows = await this.db.select().from(agents).where(eq(agents.name, name)).limit(1);
    return rows[0] ?? null;
  }

  async getAgentByAddress(address: string): Promise<AgentRecord | null> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(eq(agents.walletAddress, address))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertAgent(input: NewAgentInput): Promise<AgentRecord> {
    const now = input.createdAt ?? new Date();
    try {
      const rows = await this.db
        .insert(agents)
        .values({
          id: input.id,
          name: input.name,
          objective: input.objective,
          status: input.status ?? "active",
          brain: input.brain,
          brainModel: input.brainModel ?? null,
          walletAddress: input.walletAddress,
          walletRef: input.walletRef,
          balanceDrops: input.balanceDrops ?? 0n,
          reputation: input.reputation ?? 50,
          strategy: input.strategy ?? {},
          budgetPolicy: input.budgetPolicy,
          locationId: input.locationId,
          experimentId: input.experimentId ?? null,
          startingCapitalDrops: input.startingCapitalDrops ?? 0n,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return first(rows, "agent", input.id);
    } catch (e) {
      return asConflict(e, "agent id, name or wallet already in use", {
        id: input.id,
        name: input.name,
      });
    }
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<AgentRecord> {
    const rows = await this.db
      .update(agents)
      .set({ ...defined({ ...patch }), updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning();
    return first(rows, "agent", id);
  }

  // ── inventory ───────────────────────────────────────────────────────────────

  async getInventory(agentId: string): Promise<InventoryItemRecord[]> {
    return this.db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.agentId, agentId))
      .orderBy(asc(inventoryItems.id));
  }

  async adjustInventory(
    agentId: string,
    resourceType: ResourceType,
    locationId: string,
    delta: number,
    id: string,
  ): Promise<InventoryItemRecord> {
    if (!Number.isInteger(delta)) {
      throw new AigentiaError("VALIDATION_FAILED", "inventory delta must be an integer", { delta });
    }
    const key = and(
      eq(inventoryItems.agentId, agentId),
      eq(inventoryItems.resourceType, resourceType),
      eq(inventoryItems.locationId, locationId),
    );
    const updated = await this.db
      .update(inventoryItems)
      .set({ quantity: sql`${inventoryItems.quantity} + ${delta}`, updatedAt: new Date() })
      .where(and(key, sql`${inventoryItems.quantity} + ${delta} >= 0`))
      .returning();
    if (updated[0]) return updated[0];
    if (delta < 0) {
      const existing = await this.db.select().from(inventoryItems).where(key).limit(1);
      throw new AigentiaError("INSUFFICIENT_FUNDS", "insufficient inventory", {
        agentId,
        resourceType,
        locationId,
        have: existing[0]?.quantity ?? 0,
        need: -delta,
      });
    }
    const now = new Date();
    const inserted = await this.db
      .insert(inventoryItems)
      .values({
        id,
        agentId,
        resourceType,
        locationId,
        quantity: delta,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [inventoryItems.agentId, inventoryItems.resourceType, inventoryItems.locationId],
        set: { quantity: sql`${inventoryItems.quantity} + ${delta}`, updatedAt: now },
      })
      .returning();
    return first(inserted, "inventory", id);
  }

  // ── listings ────────────────────────────────────────────────────────────────

  async listListings(filter: ListingFilter = {}): Promise<ListingRecord[]> {
    const conditions = [];
    if (filter.status !== undefined) conditions.push(eq(resourceListings.status, filter.status));
    if (filter.resourceType !== undefined)
      conditions.push(eq(resourceListings.resourceType, filter.resourceType));
    if (filter.sellerAgentId !== undefined)
      conditions.push(eq(resourceListings.sellerAgentId, filter.sellerAgentId));
    return this.db
      .select()
      .from(resourceListings)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(resourceListings.createdAt), asc(resourceListings.id));
  }

  async getListing(id: string): Promise<ListingRecord | null> {
    const rows = await this.db
      .select()
      .from(resourceListings)
      .where(eq(resourceListings.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async createListing(input: NewListingInput): Promise<ListingRecord> {
    const now = input.createdAt ?? new Date();
    const rows = await this.db
      .insert(resourceListings)
      .values({
        id: input.id,
        sellerAgentId: input.sellerAgentId,
        resourceType: input.resourceType,
        quantity: input.quantity,
        unitPriceDrops: input.unitPriceDrops,
        status: "open",
        tick: input.tick,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return first(rows, "listing", input.id);
  }

  async fillListing(listingId: string, quantity: number): Promise<ListingRecord | null> {
    if (!Number.isInteger(quantity) || quantity < 1) return null;
    const rows = await this.db
      .update(resourceListings)
      .set({
        quantity: sql`${resourceListings.quantity} - ${quantity}`,
        status: sql`case when ${resourceListings.quantity} - ${quantity} = 0 then 'filled'::listing_status else 'open'::listing_status end`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(resourceListings.id, listingId),
          eq(resourceListings.status, "open"),
          gte(resourceListings.quantity, quantity),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  // ── services ────────────────────────────────────────────────────────────────

  async listServices(filter: ServiceFilter = {}): Promise<ServiceRecord[]> {
    const conditions = [];
    if (filter.kind !== undefined) conditions.push(eq(services.kind, filter.kind));
    if (filter.status !== undefined) conditions.push(eq(services.status, filter.status));
    if (filter.sellerAgentId !== undefined)
      conditions.push(eq(services.sellerAgentId, filter.sellerAgentId));
    return this.db
      .select()
      .from(services)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(services.id));
  }

  async getService(id: string): Promise<ServiceRecord | null> {
    const rows = await this.db.select().from(services).where(eq(services.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async upsertService(input: UpsertServiceInput): Promise<ServiceRecord> {
    const now = input.createdAt ?? new Date();
    const rows = await this.db
      .insert(services)
      .values({
        id: input.id,
        sellerAgentId: input.sellerAgentId,
        kind: input.kind,
        name: input.name,
        description: input.description,
        endpoint: input.endpoint,
        priceDrops: input.priceDrops,
        inputSchema: input.inputSchema,
        outputSchema: input.outputSchema,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [services.sellerAgentId, services.kind],
        set: {
          name: input.name,
          description: input.description,
          endpoint: input.endpoint,
          priceDrops: input.priceDrops,
          inputSchema: input.inputSchema,
          outputSchema: input.outputSchema,
          status: "active",
          updatedAt: now,
        },
      })
      .returning();
    return first(rows, "service", input.id);
  }

  async recordServiceCall(serviceId: string, call: ServiceCallInput): Promise<ServiceRecord> {
    const latency = BigInt(Math.max(0, Math.round(call.latencyMs)));
    const rows = await this.db
      .update(services)
      .set({
        successfulCalls: call.success
          ? sql`${services.successfulCalls} + 1`
          : services.successfulCalls,
        failedCalls: call.success ? services.failedCalls : sql`${services.failedCalls} + 1`,
        totalRevenueDrops: sql`${services.totalRevenueDrops} + ${call.revenueDrops}`,
        latencySumMs: sql`${services.latencySumMs} + ${latency}`,
        latencyCount: sql`${services.latencyCount} + 1`,
        lastCalledAt: call.at,
        updatedAt: call.at,
      })
      .where(eq(services.id, serviceId))
      .returning();
    return first(rows, "service", serviceId);
  }

  // ── invocations ─────────────────────────────────────────────────────────────

  async createInvocation(input: NewInvocationInput): Promise<InvocationRecord> {
    const now = input.createdAt ?? new Date();
    try {
      const rows = await this.db
        .insert(serviceInvocations)
        .values({
          id: input.id,
          serviceId: input.serviceId,
          sellerAgentId: input.sellerAgentId,
          buyerAgentId: input.buyerAgentId,
          buyerAddress: input.buyerAddress,
          invoiceId: input.invoiceId,
          status: "quoted",
          priceDrops: input.priceDrops,
          paymentRequirements: input.paymentRequirements,
          request: input.request,
          tick: input.tick,
          expiresAt: input.expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return first(rows, "invocation", input.id);
    } catch (e) {
      return asConflict(e, `invoice ${input.invoiceId} already quoted`, {
        invoiceId: input.invoiceId,
      });
    }
  }

  async getInvocation(id: string): Promise<InvocationRecord | null> {
    const rows = await this.db
      .select()
      .from(serviceInvocations)
      .where(eq(serviceInvocations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getInvocationByInvoice(invoiceId: string): Promise<InvocationRecord | null> {
    const rows = await this.db
      .select()
      .from(serviceInvocations)
      .where(eq(serviceInvocations.invoiceId, invoiceId))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateInvocation(id: string, patch: InvocationPatch): Promise<InvocationRecord> {
    try {
      const rows = await this.db
        .update(serviceInvocations)
        .set({ ...defined({ ...patch }), updatedAt: new Date() })
        .where(eq(serviceInvocations.id, id))
        .returning();
      return first(rows, "invocation", id);
    } catch (e) {
      return asConflict(e, `tx ${patch.txHash ?? ""} already settles an invocation`, {
        txHash: patch.txHash ?? null,
      });
    }
  }

  async transitionInvocation(
    id: string,
    from: InvocationStatus,
    patch: InvocationPatch,
  ): Promise<InvocationRecord | null> {
    try {
      const rows = await this.db
        .update(serviceInvocations)
        .set({ ...defined({ ...patch }), updatedAt: new Date() })
        .where(and(eq(serviceInvocations.id, id), eq(serviceInvocations.status, from)))
        .returning();
      return rows[0] ?? null;
    } catch (e) {
      return asConflict(e, `tx ${patch.txHash ?? ""} already settles an invocation`, {
        txHash: patch.txHash ?? null,
      });
    }
  }

  async getInvocationByTxHash(txHash: string): Promise<InvocationRecord | null> {
    const rows = await this.db
      .select()
      .from(serviceInvocations)
      .where(eq(serviceInvocations.txHash, txHash))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── jobs ────────────────────────────────────────────────────────────────────

  async listOpenJobs(): Promise<JobRecord[]> {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "open"))
      .orderBy(asc(jobs.createdAtTick), asc(jobs.id));
  }

  async listAgentJobs(agentId: string): Promise<JobRecord[]> {
    return this.db
      .select()
      .from(jobs)
      .where(or(eq(jobs.posterAgentId, agentId), eq(jobs.claimedByAgentId, agentId)))
      .orderBy(asc(jobs.createdAtTick), asc(jobs.id));
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const rows = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async createJob(input: NewJobInput): Promise<JobRecord> {
    const now = input.createdAt ?? new Date();
    const rows = await this.db
      .insert(jobs)
      .values({
        id: input.id,
        posterAgentId: input.posterAgentId,
        title: input.title,
        description: input.description,
        rewardDrops: input.rewardDrops,
        status: "open",
        requirement: input.requirement,
        createdAtTick: input.createdAtTick,
        expiresAtTick: input.expiresAtTick,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return first(rows, "job", input.id);
  }

  async claimJob(jobId: string, agentId: string, tick: number): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({
        status: "claimed",
        claimedByAgentId: agentId,
        claimedAtTick: tick,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "open")))
      .returning({ id: jobs.id });
    return rows.length === 1;
  }

  async submitJob(
    jobId: string,
    submission: Record<string, unknown>,
    tick: number,
  ): Promise<JobRecord> {
    const rows = await this.db
      .update(jobs)
      .set({ status: "submitted", submission, submittedAtTick: tick, updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .returning();
    return first(rows, "job", jobId);
  }

  async completeJob(jobId: string, paymentId: string | null): Promise<JobRecord> {
    const rows = await this.db
      .update(jobs)
      .set({ status: "completed", paymentId, updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .returning();
    return first(rows, "job", jobId);
  }

  async failJob(jobId: string): Promise<JobRecord> {
    const rows = await this.db
      .update(jobs)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .returning();
    return first(rows, "job", jobId);
  }

  async expireJobs(tick: number): Promise<JobRecord[]> {
    return this.db
      .update(jobs)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(inArray(jobs.status, ["open", "claimed"]), lte(jobs.expiresAtTick, tick)))
      .returning();
  }

  // ── payments ────────────────────────────────────────────────────────────────

  async recordPaymentIntent(input: NewPaymentIntentInput): Promise<PaymentIntentRecord> {
    const now = input.createdAt ?? new Date();
    const rows = await this.db
      .insert(paymentIntents)
      .values({
        id: input.id,
        agentId: input.agentId,
        purpose: input.purpose,
        destinationAddress: input.destinationAddress,
        destinationAgentId: input.destinationAgentId,
        asset: input.asset,
        amountDrops: input.amountDrops,
        serviceCategory: input.serviceCategory,
        actionKind: input.actionKind,
        actionId: input.actionId,
        approved: input.approved,
        policyDecision: input.policyDecision,
        tick: input.tick,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return first(rows, "payment_intent", input.id);
  }

  async recordPayment(input: NewPaymentInput): Promise<PaymentRecord> {
    const now = input.createdAt ?? new Date();
    try {
      const rows = await this.db
        .insert(payments)
        .values({
          id: input.id,
          intentId: input.intentId,
          kind: input.kind,
          status: input.status,
          ledger: input.ledger,
          senderAgentId: input.senderAgentId,
          receiverAgentId: input.receiverAgentId,
          senderAddress: input.senderAddress,
          receiverAddress: input.receiverAddress,
          asset: input.asset,
          amountDrops: input.amountDrops,
          feeDrops: input.feeDrops ?? null,
          txHash: input.txHash ?? null,
          ledgerIndex: input.ledgerIndex ?? null,
          validatedAt: input.validatedAt ?? null,
          invoiceId: input.invoiceId ?? null,
          actionKind: input.actionKind ?? null,
          actionId: input.actionId ?? null,
          tick: input.tick,
          error: input.error ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return first(rows, "payment", input.id);
    } catch (e) {
      return asConflict(e, "payment id, tx hash or invoice id already recorded", {
        id: input.id,
        txHash: input.txHash ?? null,
        invoiceId: input.invoiceId ?? null,
      });
    }
  }

  async updatePayment(id: string, patch: PaymentPatch): Promise<PaymentRecord> {
    try {
      const rows = await this.db
        .update(payments)
        .set({ ...defined({ ...patch }), updatedAt: new Date() })
        .where(eq(payments.id, id))
        .returning();
      return first(rows, "payment", id);
    } catch (e) {
      return asConflict(e, `tx ${patch.txHash ?? ""} already settles a payment`, {
        id,
        txHash: patch.txHash ?? null,
      });
    }
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const rows = await this.db.select().from(payments).where(eq(payments.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listPaymentsForAgent(agentId: string, limit = 50): Promise<PaymentRecord[]> {
    return this.db
      .select()
      .from(payments)
      .where(or(eq(payments.senderAgentId, agentId), eq(payments.receiverAgentId, agentId)))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(limit);
  }

  async sumSpentSince(agentId: string, since: Date): Promise<bigint> {
    const rows = await this.db
      .select({
        total: sql<string | number | bigint | null>`coalesce(sum(${payments.amountDrops}), 0)`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.senderAgentId, agentId),
          inArray(payments.status, ["submitted", "validated"]),
          eq(payments.asset, "XRP"),
          gte(payments.createdAt, since),
        ),
      );
    const total = rows[0]?.total;
    return total === null || total === undefined ? 0n : BigInt(String(total));
  }

  // ── trades ──────────────────────────────────────────────────────────────────

  async recordTrade(input: NewTradeInput): Promise<TradeRecord> {
    const now = input.createdAt ?? new Date();
    const rows = await this.db
      .insert(trades)
      .values({
        id: input.id,
        buyerAgentId: input.buyerAgentId,
        sellerAgentId: input.sellerAgentId,
        counterparty: input.counterparty,
        resourceType: input.resourceType,
        quantity: input.quantity,
        unitPriceDrops: input.unitPriceDrops,
        totalDrops: input.totalDrops,
        paymentId: input.paymentId,
        listingId: input.listingId,
        tick: input.tick,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return first(rows, "trade", input.id);
  }

  async listTrades(filter: TradeFilter = {}): Promise<TradeRecord[]> {
    const conditions = [];
    if (filter.tick !== undefined) conditions.push(eq(trades.tick, filter.tick));
    if (filter.counterparty !== undefined)
      conditions.push(eq(trades.counterparty, filter.counterparty));
    return this.db
      .select()
      .from(trades)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(trades.createdAt), asc(trades.id));
  }

  // ── decisions ───────────────────────────────────────────────────────────────

  async recordDecision(input: NewDecisionInput): Promise<DecisionRecord> {
    const rows = await this.db
      .insert(decisions)
      .values({
        id: input.id,
        agentId: input.agentId,
        tick: input.tick,
        observationSummary: input.observationSummary,
        action: input.action,
        summary: input.summary,
        reason: input.reason,
        rationale: input.rationale ?? null,
        costDrops: input.costDrops ?? null,
        paymentId: input.paymentId ?? null,
        txHash: input.txHash ?? null,
        outcome: input.outcome ?? null,
        outcomeStatus: input.outcomeStatus ?? "pending",
        brain: input.brain,
        latencyMs: input.latencyMs ?? null,
        createdAt: input.createdAt ?? new Date(),
      })
      .returning();
    return first(rows, "decision", input.id);
  }

  async updateDecision(id: string, patch: DecisionPatch): Promise<DecisionRecord> {
    const rows = await this.db
      .update(decisions)
      .set(defined({ ...patch }))
      .where(eq(decisions.id, id))
      .returning();
    return first(rows, "decision", id);
  }

  async listDecisions(agentId: string, limit = 50): Promise<DecisionRecord[]> {
    return this.db
      .select()
      .from(decisions)
      .where(eq(decisions.agentId, agentId))
      .orderBy(desc(decisions.tick), desc(decisions.createdAt))
      .limit(limit);
  }

  // ── events ──────────────────────────────────────────────────────────────────

  async appendEvents(events: readonly WorldEventInput[]): Promise<WorldEvent[]> {
    if (events.length === 0) return [];
    const values = events.map((input) => {
      const e = worldEventSchema.parse(input);
      return {
        tick: e.tick,
        type: e.type,
        message: e.message,
        agentId: e.agentId,
        counterpartyId: e.counterpartyId,
        experimentId: e.experimentId,
        txHash: e.txHash,
        amountDrops: e.amountDrops === null ? null : BigInt(e.amountDrops),
        payload: e.payload,
        createdAt: new Date(e.createdAt),
      };
    });
    const rows = await this.db.insert(worldEvents).values(values).returning();
    return rows.sort((a, b) => a.id - b.id).map(toWorldEvent);
  }

  async recentEvents(limit: number, filter: EventFilter = {}): Promise<WorldEvent[]> {
    const rows = await this.db
      .select()
      .from(worldEvents)
      .where(
        filter.agentId === undefined
          ? undefined
          : or(
              eq(worldEvents.agentId, filter.agentId),
              eq(worldEvents.counterpartyId, filter.agentId),
            ),
      )
      .orderBy(desc(worldEvents.id))
      .limit(limit);
    return rows.reverse().map(toWorldEvent);
  }

  // ── reputation & snapshots ──────────────────────────────────────────────────

  async addReputationEvent(
    input: ReputationEventInput,
  ): Promise<{ event: ReputationEventRecord; agent: AgentRecord }> {
    const now = input.createdAt ?? new Date();
    const events = await this.db
      .insert(reputationEvents)
      .values({
        id: input.id,
        agentId: input.agentId,
        delta: input.delta,
        reason: input.reason,
        refKind: input.refKind ?? null,
        refId: input.refId ?? null,
        tick: input.tick,
        createdAt: now,
      })
      .returning();
    const agent = await this.updateAgent(input.agentId, { reputation: input.next });
    return { event: first(events, "reputation_event", input.id), agent };
  }

  async listReputationEvents(agentId: string, limit = 50): Promise<ReputationEventRecord[]> {
    return this.db
      .select()
      .from(reputationEvents)
      .where(eq(reputationEvents.agentId, agentId))
      .orderBy(desc(reputationEvents.createdAt), desc(reputationEvents.id))
      .limit(limit);
  }

  async snapshotAgent(input: AgentSnapshotInput): Promise<void> {
    await this.db
      .insert(agentSnapshots)
      .values({
        agentId: input.agentId,
        tick: input.tick,
        balanceDrops: input.balanceDrops,
        netWorthDrops: input.netWorthDrops,
        reputation: input.reputation,
        createdAt: input.createdAt ?? new Date(),
      })
      .onConflictDoUpdate({
        target: [agentSnapshots.agentId, agentSnapshots.tick],
        set: {
          balanceDrops: input.balanceDrops,
          netWorthDrops: input.netWorthDrops,
          reputation: input.reputation,
        },
      });
  }

  async listSnapshots(agentId: string, limit = 200): Promise<AgentSnapshotRecord[]> {
    const rows = await this.db
      .select()
      .from(agentSnapshots)
      .where(eq(agentSnapshots.agentId, agentId))
      .orderBy(desc(agentSnapshots.tick))
      .limit(limit);
    return rows.reverse();
  }

  // ── knowledge ───────────────────────────────────────────────────────────────

  async getKnowledge(agentId: string): Promise<KnowledgeEntry[]> {
    const agent = await this.getAgent(agentId);
    if (!agent) throw notFound("agent", agentId);
    return knowledgeFromStrategy(agent.strategy);
  }

  async addKnowledge(
    agentId: string,
    entries: readonly KnowledgeEntry[],
  ): Promise<KnowledgeEntry[]> {
    const agent = await this.getAgent(agentId);
    if (!agent) throw notFound("agent", agentId);
    const merged = mergeKnowledge(knowledgeFromStrategy(agent.strategy), entries);
    await this.updateAgent(agentId, {
      strategy: { ...agent.strategy, knowledge: knowledgeToJson(merged) },
    });
    return merged;
  }

  // ── transactions ────────────────────────────────────────────────────────────

  async transaction<T>(fn: (tx: WorldStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new PostgresWorldStore(tx)));
  }
}
