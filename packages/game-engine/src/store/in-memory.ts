import {
  AigentiaError,
  sha256Hex,
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

export interface InMemoryWorldStoreOptions {
  /** Seed recorded in the simulation state row. */
  readonly seed?: string;
  readonly ledger?: "testnet" | "mock";
  readonly tickSeconds?: number;
  /** Time source for created/updated timestamps; defaults to the wall clock. */
  readonly clock?: () => Date;
}

interface TickRecord {
  tick: number;
  seed: string;
  startedAt: Date;
  finishedAt: Date | null;
  agentsProcessed: number;
  status: string;
  error: string | null;
}

/** Keys dropped from the state hash: wall-clock timestamps and measured latencies. */
const VOLATILE_KEYS = new Set(["latencyMs", "latencySumMs", "latencyCount"]);

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return undefined;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key.endsWith("At") || VOLATILE_KEYS.has(key)) continue;
      const v = normalize((value as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function notFound(what: string, id: string): AigentiaError {
  return new AigentiaError("NOT_FOUND", `${what} ${id} not found`, { id });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Complete, deterministic WorldStore on plain Maps (insertion order). Ids come from the
 * caller; timestamps from the injected clock. `snapshot()` / `stateHash()` expose the whole
 * state (minus timestamps and measured latencies) for determinism assertions.
 */
export class InMemoryWorldStore implements WorldStore {
  private readonly clock: () => Date;
  private simulation: SimulationStateRecord;
  private readonly ticks = new Map<number, TickRecord>();
  private readonly locations = new Map<string, LocationRecord>();
  private readonly resources = new Map<string, ResourceRecord>();
  private readonly marketPrices = new Map<string, MarketPriceRecord>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly inventory = new Map<string, InventoryItemRecord>();
  private readonly listings = new Map<string, ListingRecord>();
  private readonly services = new Map<string, ServiceRecord>();
  private readonly invocations = new Map<string, InvocationRecord>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly intents = new Map<string, PaymentIntentRecord>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly trades = new Map<string, TradeRecord>();
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly events: WorldEvent[] = [];
  private readonly reputation = new Map<string, ReputationEventRecord>();
  private readonly snapshots: AgentSnapshotRecord[] = [];
  private nextEventId = 1;
  private nextSnapshotId = 1;
  private nextReputationSeq = 1;

  constructor(options: InMemoryWorldStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.simulation = {
      id: 1,
      running: false,
      currentTick: 0,
      seed: options.seed ?? "genesis",
      ledger: options.ledger ?? "mock",
      tickSeconds: options.tickSeconds ?? 60,
      lastTickAt: null,
      updatedAt: this.clock(),
      singleton: true,
    };
  }

  // ── world ───────────────────────────────────────────────────────────────────

  async seedWorld(world: GenesisWorld): Promise<void> {
    const now = this.clock();
    for (const l of world.locations) {
      if (!this.locations.has(l.id)) this.locations.set(l.id, { ...l });
    }
    for (const r of world.resources) {
      if (!this.resources.has(r.id)) {
        this.resources.set(r.id, { ...r, createdAt: now, updatedAt: now });
      }
    }
    for (const m of world.marketPrices) {
      if (!this.marketPrices.has(m.resourceType)) {
        this.marketPrices.set(m.resourceType, { ...m, lastTick: 0, history: [] });
      }
    }
    this.simulation = { ...this.simulation, seed: world.seed, updatedAt: now };
  }

  async getSimulationState(): Promise<SimulationStateRecord> {
    return clone(this.simulation);
  }

  async setSimulationState(patch: SimulationStatePatch): Promise<SimulationStateRecord> {
    this.simulation = {
      ...this.simulation,
      ...(patch.running !== undefined ? { running: patch.running } : {}),
      ...(patch.currentTick !== undefined ? { currentTick: patch.currentTick } : {}),
      ...(patch.seed !== undefined ? { seed: patch.seed } : {}),
      ...(patch.ledger !== undefined ? { ledger: patch.ledger } : {}),
      ...(patch.tickSeconds !== undefined ? { tickSeconds: patch.tickSeconds } : {}),
      ...(patch.lastTickAt !== undefined ? { lastTickAt: patch.lastTickAt } : {}),
      updatedAt: this.clock(),
    };
    return clone(this.simulation);
  }

  async beginTick(input: BeginTickInput): Promise<void> {
    this.ticks.set(input.tick, {
      tick: input.tick,
      seed: input.seed,
      startedAt: input.startedAt,
      finishedAt: null,
      agentsProcessed: 0,
      status: "running",
      error: null,
    });
  }

  async finishTick(input: FinishTickInput): Promise<void> {
    const t = this.ticks.get(input.tick);
    if (!t) throw notFound("tick", String(input.tick));
    t.finishedAt = input.finishedAt;
    t.agentsProcessed = input.agentsProcessed;
    t.status = input.status;
    t.error = input.error ?? null;
  }

  async listLocations(): Promise<LocationRecord[]> {
    return [...this.locations.values()].map(clone);
  }

  async listResources(): Promise<ResourceRecord[]> {
    return [...this.resources.values()].map(clone);
  }

  async updateResource(id: string, patch: { quantity: number }): Promise<ResourceRecord> {
    const r = this.resources.get(id);
    if (!r) throw notFound("resource", id);
    r.quantity = patch.quantity;
    r.updatedAt = this.clock();
    return clone(r);
  }

  async getMarketPrices(): Promise<MarketPriceRecord[]> {
    return [...this.marketPrices.values()].map(clone);
  }

  async setMarketPrice(input: MarketPriceInput): Promise<MarketPriceRecord> {
    const record: MarketPriceRecord = {
      resourceType: input.resourceType,
      bidDrops: input.bidDrops,
      askDrops: input.askDrops,
      supply: input.supply,
      lastTick: input.lastTick,
      history: input.history.map((h) => ({ ...h })),
    };
    this.marketPrices.set(input.resourceType, record);
    return clone(record);
  }

  // ── agents ──────────────────────────────────────────────────────────────────

  async listAgents(filter: AgentFilter = {}): Promise<AgentRecord[]> {
    return [...this.agents.values()]
      .filter(
        (a) =>
          (filter.status === undefined || a.status === filter.status) &&
          (filter.experimentId === undefined || a.experimentId === filter.experimentId),
      )
      .sort(byId)
      .map(clone);
  }

  async listActiveAgents(): Promise<AgentRecord[]> {
    return this.listAgents({ status: "active" });
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const a = this.agents.get(id);
    return a ? clone(a) : null;
  }

  async getAgentByName(name: string): Promise<AgentRecord | null> {
    for (const a of this.agents.values()) if (a.name === name) return clone(a);
    return null;
  }

  async getAgentByAddress(address: string): Promise<AgentRecord | null> {
    for (const a of this.agents.values()) if (a.walletAddress === address) return clone(a);
    return null;
  }

  async insertAgent(input: NewAgentInput): Promise<AgentRecord> {
    if (this.agents.has(input.id)) {
      throw new AigentiaError("CONFLICT", `agent ${input.id} already exists`, { id: input.id });
    }
    for (const a of this.agents.values()) {
      if (a.name === input.name || a.walletAddress === input.walletAddress) {
        throw new AigentiaError("CONFLICT", `agent name or wallet already in use`, {
          name: input.name,
          walletAddress: input.walletAddress,
        });
      }
    }
    const now = input.createdAt ?? this.clock();
    const record: AgentRecord = {
      id: input.id,
      name: input.name,
      objective: input.objective,
      status: input.status ?? "active",
      brain: input.brain,
      brainModel: input.brainModel ?? null,
      walletAddress: input.walletAddress,
      walletRef: input.walletRef,
      balanceDrops: input.balanceDrops ?? 0n,
      balanceCheckedAt: null,
      reputation: input.reputation ?? 50,
      strategy: clone(input.strategy ?? {}),
      budgetPolicy: clone(input.budgetPolicy),
      locationId: input.locationId,
      experimentId: input.experimentId ?? null,
      startingCapitalDrops: input.startingCapitalDrops ?? 0n,
      lastTick: null,
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(record.id, record);
    return clone(record);
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<AgentRecord> {
    const a = this.agents.get(id);
    if (!a) throw notFound("agent", id);
    if (patch.status !== undefined) a.status = patch.status;
    if (patch.balanceDrops !== undefined) a.balanceDrops = patch.balanceDrops;
    if (patch.balanceCheckedAt !== undefined) a.balanceCheckedAt = patch.balanceCheckedAt;
    if (patch.reputation !== undefined) a.reputation = patch.reputation;
    if (patch.strategy !== undefined) a.strategy = clone(patch.strategy);
    if (patch.budgetPolicy !== undefined) a.budgetPolicy = clone(patch.budgetPolicy);
    if (patch.locationId !== undefined) a.locationId = patch.locationId;
    if (patch.lastTick !== undefined) a.lastTick = patch.lastTick;
    if (patch.brainModel !== undefined) a.brainModel = patch.brainModel;
    a.updatedAt = this.clock();
    return clone(a);
  }

  // ── inventory ───────────────────────────────────────────────────────────────

  async getInventory(agentId: string): Promise<InventoryItemRecord[]> {
    return [...this.inventory.values()]
      .filter((i) => i.agentId === agentId)
      .sort(byId)
      .map(clone);
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
    let line: InventoryItemRecord | undefined;
    for (const item of this.inventory.values()) {
      if (
        item.agentId === agentId &&
        item.resourceType === resourceType &&
        item.locationId === locationId
      ) {
        line = item;
        break;
      }
    }
    const current = line?.quantity ?? 0;
    if (current + delta < 0) {
      throw new AigentiaError("INSUFFICIENT_FUNDS", "insufficient inventory", {
        agentId,
        resourceType,
        locationId,
        have: current,
        need: -delta,
      });
    }
    const now = this.clock();
    if (!line) {
      line = { id, agentId, resourceType, locationId, quantity: 0, createdAt: now, updatedAt: now };
      this.inventory.set(id, line);
    }
    line.quantity = current + delta;
    line.updatedAt = now;
    return clone(line);
  }

  // ── listings ────────────────────────────────────────────────────────────────

  async listListings(filter: ListingFilter = {}): Promise<ListingRecord[]> {
    return [...this.listings.values()]
      .filter(
        (l) =>
          (filter.status === undefined || l.status === filter.status) &&
          (filter.resourceType === undefined || l.resourceType === filter.resourceType) &&
          (filter.sellerAgentId === undefined || l.sellerAgentId === filter.sellerAgentId),
      )
      .map(clone);
  }

  async getListing(id: string): Promise<ListingRecord | null> {
    const l = this.listings.get(id);
    return l ? clone(l) : null;
  }

  async createListing(input: NewListingInput): Promise<ListingRecord> {
    const now = input.createdAt ?? this.clock();
    const record: ListingRecord = {
      id: input.id,
      sellerAgentId: input.sellerAgentId,
      resourceType: input.resourceType,
      quantity: input.quantity,
      unitPriceDrops: input.unitPriceDrops,
      status: "open",
      tick: input.tick,
      createdAt: now,
      updatedAt: now,
    };
    this.listings.set(record.id, record);
    return clone(record);
  }

  async fillListing(listingId: string, quantity: number): Promise<ListingRecord | null> {
    const l = this.listings.get(listingId);
    if (!l || l.status !== "open" || quantity < 1 || l.quantity < quantity) return null;
    l.quantity -= quantity;
    if (l.quantity === 0) l.status = "filled";
    l.updatedAt = this.clock();
    return clone(l);
  }

  // ── services ────────────────────────────────────────────────────────────────

  async listServices(filter: ServiceFilter = {}): Promise<ServiceRecord[]> {
    return [...this.services.values()]
      .filter(
        (s) =>
          (filter.kind === undefined || s.kind === filter.kind) &&
          (filter.status === undefined || s.status === filter.status) &&
          (filter.sellerAgentId === undefined || s.sellerAgentId === filter.sellerAgentId),
      )
      .sort(byId)
      .map(clone);
  }

  async getService(id: string): Promise<ServiceRecord | null> {
    const s = this.services.get(id);
    return s ? clone(s) : null;
  }

  async upsertService(input: UpsertServiceInput): Promise<ServiceRecord> {
    const now = input.createdAt ?? this.clock();
    for (const s of this.services.values()) {
      if (s.sellerAgentId === input.sellerAgentId && s.kind === input.kind) {
        s.name = input.name;
        s.description = input.description;
        s.endpoint = input.endpoint;
        s.priceDrops = input.priceDrops;
        s.inputSchema = clone(input.inputSchema);
        s.outputSchema = clone(input.outputSchema);
        s.status = "active";
        s.updatedAt = now;
        return clone(s);
      }
    }
    const record: ServiceRecord = {
      id: input.id,
      sellerAgentId: input.sellerAgentId,
      kind: input.kind,
      name: input.name,
      description: input.description,
      endpoint: input.endpoint,
      priceDrops: input.priceDrops,
      asset: "XRP",
      inputSchema: clone(input.inputSchema),
      outputSchema: clone(input.outputSchema),
      status: "active",
      successfulCalls: 0,
      failedCalls: 0,
      totalRevenueDrops: 0n,
      latencySumMs: 0n,
      latencyCount: 0,
      lastCalledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.services.set(record.id, record);
    return clone(record);
  }

  async recordServiceCall(serviceId: string, call: ServiceCallInput): Promise<ServiceRecord> {
    const s = this.services.get(serviceId);
    if (!s) throw notFound("service", serviceId);
    if (call.success) s.successfulCalls += 1;
    else s.failedCalls += 1;
    s.totalRevenueDrops += call.revenueDrops;
    s.latencySumMs += BigInt(Math.max(0, Math.round(call.latencyMs)));
    s.latencyCount += 1;
    s.lastCalledAt = call.at;
    s.updatedAt = call.at;
    return clone(s);
  }

  // ── invocations ─────────────────────────────────────────────────────────────

  async createInvocation(input: NewInvocationInput): Promise<InvocationRecord> {
    for (const inv of this.invocations.values()) {
      if (inv.invoiceId === input.invoiceId) {
        throw new AigentiaError("CONFLICT", `invoice ${input.invoiceId} already quoted`, {
          invoiceId: input.invoiceId,
        });
      }
    }
    const now = input.createdAt ?? this.clock();
    const record: InvocationRecord = {
      id: input.id,
      serviceId: input.serviceId,
      sellerAgentId: input.sellerAgentId,
      buyerAgentId: input.buyerAgentId,
      buyerAddress: input.buyerAddress,
      invoiceId: input.invoiceId,
      status: "quoted",
      priceDrops: input.priceDrops,
      paymentRequirements: clone(input.paymentRequirements),
      paymentId: null,
      txHash: null,
      request: clone(input.request),
      response: null,
      latencyMs: null,
      error: null,
      tick: input.tick,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    this.invocations.set(record.id, record);
    return clone(record);
  }

  async getInvocation(id: string): Promise<InvocationRecord | null> {
    const inv = this.invocations.get(id);
    return inv ? clone(inv) : null;
  }

  async getInvocationByInvoice(invoiceId: string): Promise<InvocationRecord | null> {
    for (const inv of this.invocations.values()) if (inv.invoiceId === invoiceId) return clone(inv);
    return null;
  }

  async updateInvocation(id: string, patch: InvocationPatch): Promise<InvocationRecord> {
    const inv = this.invocations.get(id);
    if (!inv) throw notFound("invocation", id);
    if (patch.txHash) {
      for (const other of this.invocations.values()) {
        if (other.id !== id && other.txHash === patch.txHash) {
          throw new AigentiaError("CONFLICT", `tx ${patch.txHash} already settles an invocation`, {
            txHash: patch.txHash,
          });
        }
      }
    }
    if (patch.status !== undefined) inv.status = patch.status;
    if (patch.buyerAgentId !== undefined) inv.buyerAgentId = patch.buyerAgentId;
    if (patch.buyerAddress !== undefined) inv.buyerAddress = patch.buyerAddress;
    if (patch.paymentId !== undefined) inv.paymentId = patch.paymentId;
    if (patch.txHash !== undefined) inv.txHash = patch.txHash;
    if (patch.response !== undefined) inv.response = patch.response ? clone(patch.response) : null;
    if (patch.latencyMs !== undefined) inv.latencyMs = patch.latencyMs;
    if (patch.error !== undefined) inv.error = patch.error;
    inv.updatedAt = this.clock();
    return clone(inv);
  }

  async transitionInvocation(
    id: string,
    from: InvocationStatus,
    patch: InvocationPatch,
  ): Promise<InvocationRecord | null> {
    const inv = this.invocations.get(id);
    if (!inv) throw notFound("invocation", id);
    if (inv.status !== from) return null;
    return this.updateInvocation(id, patch);
  }

  async getInvocationByTxHash(txHash: string): Promise<InvocationRecord | null> {
    for (const inv of this.invocations.values()) if (inv.txHash === txHash) return clone(inv);
    return null;
  }

  // ── jobs ────────────────────────────────────────────────────────────────────

  async listOpenJobs(): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((j) => j.status === "open").map(clone);
  }

  async listAgentJobs(agentId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => j.posterAgentId === agentId || j.claimedByAgentId === agentId)
      .map(clone);
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const j = this.jobs.get(id);
    return j ? clone(j) : null;
  }

  async createJob(input: NewJobInput): Promise<JobRecord> {
    const now = input.createdAt ?? this.clock();
    const record: JobRecord = {
      id: input.id,
      posterAgentId: input.posterAgentId,
      title: input.title,
      description: input.description,
      rewardDrops: input.rewardDrops,
      status: "open",
      requirement: input.requirement ? clone(input.requirement) : null,
      claimedByAgentId: null,
      claimedAtTick: null,
      submission: null,
      submittedAtTick: null,
      paymentId: null,
      createdAtTick: input.createdAtTick,
      expiresAtTick: input.expiresAtTick,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(record.id, record);
    return clone(record);
  }

  async claimJob(jobId: string, agentId: string, tick: number): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "open") return false;
    j.status = "claimed";
    j.claimedByAgentId = agentId;
    j.claimedAtTick = tick;
    j.updatedAt = this.clock();
    return true;
  }

  async submitJob(
    jobId: string,
    submission: Record<string, unknown>,
    tick: number,
  ): Promise<JobRecord> {
    const j = this.jobs.get(jobId);
    if (!j) throw notFound("job", jobId);
    j.status = "submitted";
    j.submission = clone(submission);
    j.submittedAtTick = tick;
    j.updatedAt = this.clock();
    return clone(j);
  }

  async completeJob(jobId: string, paymentId: string | null): Promise<JobRecord> {
    const j = this.jobs.get(jobId);
    if (!j) throw notFound("job", jobId);
    j.status = "completed";
    j.paymentId = paymentId;
    j.updatedAt = this.clock();
    return clone(j);
  }

  async failJob(jobId: string): Promise<JobRecord> {
    const j = this.jobs.get(jobId);
    if (!j) throw notFound("job", jobId);
    j.status = "failed";
    j.updatedAt = this.clock();
    return clone(j);
  }

  async expireJobs(tick: number): Promise<JobRecord[]> {
    const out: JobRecord[] = [];
    const now = this.clock();
    for (const j of this.jobs.values()) {
      if ((j.status === "open" || j.status === "claimed") && j.expiresAtTick <= tick) {
        j.status = "expired";
        j.updatedAt = now;
        out.push(clone(j));
      }
    }
    return out;
  }

  // ── payments ────────────────────────────────────────────────────────────────

  async recordPaymentIntent(input: NewPaymentIntentInput): Promise<PaymentIntentRecord> {
    const now = input.createdAt ?? this.clock();
    const record: PaymentIntentRecord = {
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
      policyDecision: clone(input.policyDecision),
      tick: input.tick,
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(record.id, record);
    return clone(record);
  }

  private assertPaymentUnique(
    exceptId: string | null,
    txHash: string | null | undefined,
    invoiceId: string | null | undefined,
  ): void {
    for (const p of this.payments.values()) {
      if (p.id === exceptId) continue;
      if (txHash && p.txHash === txHash) {
        throw new AigentiaError("CONFLICT", `tx ${txHash} already settles payment ${p.id}`, {
          txHash,
          paymentId: p.id,
        });
      }
      if (invoiceId && p.invoiceId === invoiceId) {
        throw new AigentiaError("CONFLICT", `invoice ${invoiceId} already paid by ${p.id}`, {
          invoiceId,
          paymentId: p.id,
        });
      }
    }
  }

  async recordPayment(input: NewPaymentInput): Promise<PaymentRecord> {
    if (this.payments.has(input.id)) {
      throw new AigentiaError("CONFLICT", `payment ${input.id} already exists`, { id: input.id });
    }
    this.assertPaymentUnique(null, input.txHash, input.invoiceId);
    const now = input.createdAt ?? this.clock();
    const record: PaymentRecord = {
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
    };
    this.payments.set(record.id, record);
    return clone(record);
  }

  async updatePayment(id: string, patch: PaymentPatch): Promise<PaymentRecord> {
    const p = this.payments.get(id);
    if (!p) throw notFound("payment", id);
    this.assertPaymentUnique(id, patch.txHash, null);
    if (patch.status !== undefined) p.status = patch.status;
    if (patch.txHash !== undefined) p.txHash = patch.txHash;
    if (patch.ledgerIndex !== undefined) p.ledgerIndex = patch.ledgerIndex;
    if (patch.validatedAt !== undefined) p.validatedAt = patch.validatedAt;
    if (patch.feeDrops !== undefined) p.feeDrops = patch.feeDrops;
    if (patch.error !== undefined) p.error = patch.error;
    p.updatedAt = this.clock();
    return clone(p);
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const p = this.payments.get(id);
    return p ? clone(p) : null;
  }

  async listPaymentsForAgent(agentId: string, limit = 50): Promise<PaymentRecord[]> {
    return [...this.payments.values()]
      .filter((p) => p.senderAgentId === agentId || p.receiverAgentId === agentId)
      .slice(-limit)
      .reverse()
      .map(clone);
  }

  async sumSpentSince(agentId: string, since: Date): Promise<bigint> {
    let total = 0n;
    const sinceMs = since.getTime();
    for (const p of this.payments.values()) {
      if (p.senderAgentId !== agentId) continue;
      if (p.status !== "submitted" && p.status !== "validated") continue;
      if (p.asset !== "XRP") continue;
      if (p.createdAt.getTime() >= sinceMs) total += p.amountDrops;
    }
    return total;
  }

  // ── trades ──────────────────────────────────────────────────────────────────

  async recordTrade(input: NewTradeInput): Promise<TradeRecord> {
    const now = input.createdAt ?? this.clock();
    const record: TradeRecord = {
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
    };
    this.trades.set(record.id, record);
    return clone(record);
  }

  async listTrades(filter: TradeFilter = {}): Promise<TradeRecord[]> {
    return [...this.trades.values()]
      .filter(
        (t) =>
          (filter.tick === undefined || t.tick === filter.tick) &&
          (filter.counterparty === undefined || t.counterparty === filter.counterparty),
      )
      .map(clone);
  }

  // ── decisions ───────────────────────────────────────────────────────────────

  async recordDecision(input: NewDecisionInput): Promise<DecisionRecord> {
    const record: DecisionRecord = {
      id: input.id,
      agentId: input.agentId,
      tick: input.tick,
      observationSummary: input.observationSummary,
      action: clone(input.action),
      summary: input.summary,
      reason: input.reason,
      rationale: input.rationale ? clone(input.rationale) : null,
      costDrops: input.costDrops ?? null,
      paymentId: input.paymentId ?? null,
      txHash: input.txHash ?? null,
      outcome: input.outcome ?? null,
      outcomeStatus: input.outcomeStatus ?? "pending",
      brain: input.brain,
      latencyMs: input.latencyMs ?? null,
      createdAt: input.createdAt ?? this.clock(),
    };
    this.decisions.set(record.id, record);
    return clone(record);
  }

  async updateDecision(id: string, patch: DecisionPatch): Promise<DecisionRecord> {
    const d = this.decisions.get(id);
    if (!d) throw notFound("decision", id);
    if (patch.costDrops !== undefined) d.costDrops = patch.costDrops;
    if (patch.paymentId !== undefined) d.paymentId = patch.paymentId;
    if (patch.txHash !== undefined) d.txHash = patch.txHash;
    if (patch.outcome !== undefined) d.outcome = patch.outcome;
    if (patch.outcomeStatus !== undefined) d.outcomeStatus = patch.outcomeStatus;
    if (patch.latencyMs !== undefined) d.latencyMs = patch.latencyMs;
    return clone(d);
  }

  async listDecisions(agentId: string, limit = 50): Promise<DecisionRecord[]> {
    return [...this.decisions.values()]
      .filter((d) => d.agentId === agentId)
      .slice(-limit)
      .reverse()
      .map(clone);
  }

  // ── events ──────────────────────────────────────────────────────────────────

  async appendEvents(events: readonly WorldEventInput[]): Promise<WorldEvent[]> {
    const out: WorldEvent[] = [];
    for (const input of events) {
      const parsed = worldEventSchema.parse({ ...input, id: this.nextEventId });
      this.nextEventId += 1;
      this.events.push(parsed);
      out.push(clone(parsed));
    }
    return out;
  }

  async recentEvents(limit: number, filter: EventFilter = {}): Promise<WorldEvent[]> {
    const source =
      filter.agentId === undefined
        ? this.events
        : this.events.filter(
            (e) => e.agentId === filter.agentId || e.counterpartyId === filter.agentId,
          );
    return source.slice(-limit).map(clone);
  }

  // ── reputation & snapshots ──────────────────────────────────────────────────

  async addReputationEvent(
    input: ReputationEventInput,
  ): Promise<{ event: ReputationEventRecord; agent: AgentRecord }> {
    const a = this.agents.get(input.agentId);
    if (!a) throw notFound("agent", input.agentId);
    const now = input.createdAt ?? this.clock();
    const event: ReputationEventRecord = {
      id: input.id,
      agentId: input.agentId,
      delta: input.delta,
      reason: input.reason,
      refKind: input.refKind ?? null,
      refId: input.refId ?? null,
      tick: input.tick,
      createdAt: now,
    };
    this.reputation.set(`${this.nextReputationSeq}:${event.id}`, event);
    this.nextReputationSeq += 1;
    a.reputation = input.next;
    a.updatedAt = now;
    return { event: clone(event), agent: clone(a) };
  }

  async listReputationEvents(agentId: string, limit = 50): Promise<ReputationEventRecord[]> {
    return [...this.reputation.values()]
      .filter((r) => r.agentId === agentId)
      .slice(-limit)
      .reverse()
      .map(clone);
  }

  async snapshotAgent(input: AgentSnapshotInput): Promise<void> {
    const existing = this.snapshots.findIndex(
      (s) => s.agentId === input.agentId && s.tick === input.tick,
    );
    const record: AgentSnapshotRecord = {
      id:
        existing >= 0 ? (this.snapshots[existing]?.id ?? this.nextSnapshotId) : this.nextSnapshotId,
      agentId: input.agentId,
      tick: input.tick,
      balanceDrops: input.balanceDrops,
      netWorthDrops: input.netWorthDrops,
      reputation: input.reputation,
      createdAt: input.createdAt ?? this.clock(),
    };
    if (existing >= 0) this.snapshots[existing] = record;
    else {
      this.snapshots.push(record);
      this.nextSnapshotId += 1;
    }
  }

  async listSnapshots(agentId: string, limit = 200): Promise<AgentSnapshotRecord[]> {
    return this.snapshots
      .filter((s) => s.agentId === agentId)
      .slice(-limit)
      .map(clone);
  }

  // ── knowledge ───────────────────────────────────────────────────────────────

  async getKnowledge(agentId: string): Promise<KnowledgeEntry[]> {
    const a = this.agents.get(agentId);
    if (!a) throw notFound("agent", agentId);
    return knowledgeFromStrategy(a.strategy);
  }

  async addKnowledge(
    agentId: string,
    entries: readonly KnowledgeEntry[],
  ): Promise<KnowledgeEntry[]> {
    const a = this.agents.get(agentId);
    if (!a) throw notFound("agent", agentId);
    const merged = mergeKnowledge(knowledgeFromStrategy(a.strategy), entries);
    a.strategy = { ...a.strategy, knowledge: knowledgeToJson(merged) };
    a.updatedAt = this.clock();
    return merged;
  }

  // ── transactions & determinism helpers ──────────────────────────────────────

  /** Single-threaded: runs `fn` against this store (no rollback on failure). */
  async transaction<T>(fn: (tx: WorldStore) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Every table as plain JSON (bigints as strings, timestamps and latencies removed). */
  snapshot(): Record<string, unknown> {
    return normalize({
      simulation: this.simulation,
      ticks: [...this.ticks.values()],
      locations: [...this.locations.values()],
      resources: [...this.resources.values()],
      marketPrices: [...this.marketPrices.values()],
      agents: [...this.agents.values()],
      inventory: [...this.inventory.values()],
      listings: [...this.listings.values()],
      services: [...this.services.values()],
      invocations: [...this.invocations.values()],
      jobs: [...this.jobs.values()],
      intents: [...this.intents.values()],
      payments: [...this.payments.values()],
      trades: [...this.trades.values()],
      decisions: [...this.decisions.values()],
      events: this.events,
      reputation: [...this.reputation.values()],
      snapshots: this.snapshots,
    }) as Record<string, unknown>;
  }

  /** sha256 of the normalised snapshot: equal for two runs of the same seeded world. */
  stateHash(): string {
    return sha256Hex(JSON.stringify(this.snapshot()));
  }

  /** All events in insertion order (tests). */
  allEvents(): WorldEvent[] {
    return this.events.map(clone);
  }
}
