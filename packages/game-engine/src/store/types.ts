import type {
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
  trades,
} from "@aigentia/db";
import type {
  AgentStatus,
  BrainKind,
  InvocationStatus,
  Objective,
  PaymentKind,
  PaymentStatus,
  ResourceType,
  ServiceKind,
} from "@aigentia/shared";
import type { BudgetPolicy, WorldEvent, WorldEventInput } from "@aigentia/protocol";
import type { GenesisWorld } from "../world";

/*
 * Records are the database row shapes (drizzle `$inferSelect`) so the Postgres store maps
 * one-to-one and the in-memory store is forced to hold exactly the same state. Money is
 * bigint drops, timestamps are Dates.
 */
export type AgentRecord = typeof agents.$inferSelect;
export type LocationRecord = typeof locations.$inferSelect;
export type ResourceRecord = typeof resources.$inferSelect;
export type MarketPriceRecord = typeof marketPrices.$inferSelect;
export type MarketHistoryEntry = MarketPriceRecord["history"][number];
export type InventoryItemRecord = typeof inventoryItems.$inferSelect;
export type ListingRecord = typeof resourceListings.$inferSelect;
export type ServiceRecord = typeof services.$inferSelect;
export type InvocationRecord = typeof serviceInvocations.$inferSelect;
export type JobRecord = typeof jobs.$inferSelect;
export type PaymentIntentRecord = typeof paymentIntents.$inferSelect;
export type PaymentRecord = typeof payments.$inferSelect;
export type TradeRecord = typeof trades.$inferSelect;
export type DecisionRecord = typeof decisions.$inferSelect;
export type ReputationEventRecord = typeof reputationEvents.$inferSelect;
export type AgentSnapshotRecord = typeof agentSnapshots.$inferSelect;
export type SimulationStateRecord = typeof simulationState.$inferSelect;

export type ListingStatus = ListingRecord["status"];
export type ServiceStatus = ServiceRecord["status"];
export type DecisionOutcomeStatus = DecisionRecord["outcomeStatus"];

/** Resource intel an agent bought (SCOUT) — stored inside `agents.strategy.knowledge`. */
export interface KnowledgeEntry {
  readonly resourceType: ResourceType;
  readonly locationId: string;
  readonly quantity: number;
  readonly learnedAtTick: number;
}

export interface NewAgentInput {
  readonly id: string;
  readonly name: string;
  readonly objective: Objective;
  readonly status?: AgentStatus;
  readonly brain: BrainKind;
  readonly brainModel?: string | null;
  readonly walletAddress: string;
  readonly walletRef: string;
  readonly balanceDrops?: bigint;
  readonly reputation?: number;
  readonly strategy?: Record<string, unknown>;
  readonly budgetPolicy: BudgetPolicy;
  readonly locationId: string;
  readonly experimentId?: string | null;
  readonly startingCapitalDrops?: bigint;
  readonly createdAt?: Date;
}

export type AgentPatch = Partial<
  Pick<
    AgentRecord,
    | "status"
    | "balanceDrops"
    | "balanceCheckedAt"
    | "reputation"
    | "strategy"
    | "budgetPolicy"
    | "locationId"
    | "lastTick"
    | "brainModel"
  >
>;

export interface AgentFilter {
  readonly status?: AgentStatus;
  readonly experimentId?: string | null;
}

export interface SimulationStatePatch {
  readonly running?: boolean;
  readonly currentTick?: number;
  readonly seed?: string;
  readonly ledger?: "testnet" | "mock";
  readonly tickSeconds?: number;
  readonly lastTickAt?: Date | null;
}

export interface BeginTickInput {
  readonly tick: number;
  readonly seed: string;
  readonly startedAt: Date;
}

export interface FinishTickInput {
  readonly tick: number;
  readonly finishedAt: Date;
  readonly agentsProcessed: number;
  readonly status: "finished" | "failed";
  readonly error?: string | null;
}

export interface MarketPriceInput {
  readonly resourceType: ResourceType;
  readonly bidDrops: bigint;
  readonly askDrops: bigint;
  readonly supply: number;
  readonly lastTick: number;
  readonly history: readonly MarketHistoryEntry[];
}

export interface NewListingInput {
  readonly id: string;
  readonly sellerAgentId: string;
  readonly resourceType: ResourceType;
  readonly quantity: number;
  readonly unitPriceDrops: bigint;
  readonly tick: number;
  readonly createdAt?: Date;
}

export interface ListingFilter {
  readonly status?: ListingStatus;
  readonly resourceType?: ResourceType;
  readonly sellerAgentId?: string;
}

export interface ServiceFilter {
  readonly kind?: ServiceKind;
  readonly status?: ServiceStatus;
  readonly sellerAgentId?: string;
}

/** Insert, or update price/description/endpoint of the seller's existing service of that kind. */
export interface UpsertServiceInput {
  readonly id: string;
  readonly sellerAgentId: string;
  readonly kind: ServiceKind;
  readonly name: string;
  readonly description: string;
  readonly endpoint: string;
  readonly priceDrops: bigint;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly createdAt?: Date;
}

export interface ServiceCallInput {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly revenueDrops: bigint;
  readonly at: Date;
}

export interface NewInvocationInput {
  readonly id: string;
  readonly serviceId: string;
  readonly sellerAgentId: string;
  readonly buyerAgentId: string | null;
  readonly buyerAddress: string | null;
  readonly invoiceId: string;
  readonly priceDrops: bigint;
  readonly paymentRequirements: Record<string, unknown>;
  readonly request: Record<string, unknown>;
  readonly tick: number;
  readonly expiresAt: Date;
  readonly createdAt?: Date;
}

export interface InvocationPatch {
  readonly status?: InvocationStatus;
  readonly paymentId?: string | null;
  readonly txHash?: string | null;
  readonly response?: Record<string, unknown> | null;
  readonly latencyMs?: number | null;
  readonly error?: string | null;
}

export interface NewJobInput {
  readonly id: string;
  readonly posterAgentId: string;
  readonly title: string;
  readonly description: string;
  readonly rewardDrops: bigint;
  readonly requirement: Record<string, unknown> | null;
  readonly createdAtTick: number;
  readonly expiresAtTick: number;
  readonly createdAt?: Date;
}

export interface NewPaymentIntentInput {
  readonly id: string;
  readonly agentId: string;
  readonly purpose: PaymentKind;
  readonly destinationAddress: string;
  readonly destinationAgentId: string | null;
  readonly asset: string;
  readonly amountDrops: bigint;
  readonly serviceCategory: string | null;
  readonly actionKind: string;
  readonly actionId: string;
  readonly approved: boolean;
  readonly policyDecision: Record<string, unknown>;
  readonly tick: number;
  readonly createdAt?: Date;
}

export interface NewPaymentInput {
  readonly id: string;
  readonly intentId: string | null;
  readonly kind: PaymentKind;
  readonly status: PaymentStatus;
  readonly ledger: "testnet" | "mock";
  readonly senderAgentId: string | null;
  readonly receiverAgentId: string | null;
  readonly senderAddress: string;
  readonly receiverAddress: string;
  readonly asset: string;
  readonly amountDrops: bigint;
  readonly feeDrops?: bigint | null;
  readonly txHash?: string | null;
  readonly ledgerIndex?: number | null;
  readonly validatedAt?: Date | null;
  readonly invoiceId?: string | null;
  readonly actionKind?: string | null;
  readonly actionId?: string | null;
  readonly tick: number;
  readonly error?: string | null;
  readonly createdAt?: Date;
}

export interface PaymentPatch {
  readonly status?: PaymentStatus;
  readonly txHash?: string | null;
  readonly ledgerIndex?: number | null;
  readonly validatedAt?: Date | null;
  readonly feeDrops?: bigint | null;
  readonly error?: string | null;
}

export interface NewTradeInput {
  readonly id: string;
  readonly buyerAgentId: string | null;
  readonly sellerAgentId: string | null;
  /** "agent" for listings, "market" when the world market is the counterparty. */
  readonly counterparty: "agent" | "market";
  readonly resourceType: ResourceType;
  readonly quantity: number;
  readonly unitPriceDrops: bigint;
  readonly totalDrops: bigint;
  readonly paymentId: string | null;
  readonly listingId: string | null;
  readonly tick: number;
  readonly createdAt?: Date;
}

export interface NewDecisionInput {
  readonly id: string;
  readonly agentId: string;
  readonly tick: number;
  readonly observationSummary: string;
  readonly action: Record<string, unknown>;
  readonly summary: string;
  readonly reason: string;
  readonly rationale?: Record<string, unknown> | null;
  readonly costDrops?: bigint | null;
  readonly paymentId?: string | null;
  readonly txHash?: string | null;
  readonly outcome?: string | null;
  readonly outcomeStatus?: DecisionOutcomeStatus;
  readonly brain: string;
  readonly latencyMs?: number | null;
  readonly createdAt?: Date;
}

export interface DecisionPatch {
  readonly costDrops?: bigint | null;
  readonly paymentId?: string | null;
  readonly txHash?: string | null;
  readonly outcome?: string | null;
  readonly outcomeStatus?: DecisionOutcomeStatus;
  readonly latencyMs?: number | null;
}

export interface ReputationEventInput {
  readonly id: string;
  readonly agentId: string;
  /** Effective change after clamping. */
  readonly delta: number;
  /** Resulting score (0..100); written to `agents.reputation`. */
  readonly next: number;
  readonly reason: string;
  readonly refKind?: string | null;
  readonly refId?: string | null;
  readonly tick: number;
  readonly createdAt?: Date;
}

export interface AgentSnapshotInput {
  readonly agentId: string;
  readonly tick: number;
  readonly balanceDrops: bigint;
  readonly netWorthDrops: bigint;
  readonly reputation: number;
  readonly createdAt?: Date;
}

export interface EventFilter {
  readonly agentId?: string;
}

export interface TradeFilter {
  readonly tick?: number;
  readonly counterparty?: "agent" | "market";
}

/**
 * The persistence boundary of the engine. Two implementations: InMemoryWorldStore
 * (deterministic tests, SIM_LEDGER=mock demos) and PostgresWorldStore (drizzle).
 * Every method is async so both share one contract; money is bigint drops throughout.
 */
export interface WorldStore {
  /** Idempotently insert locations, resource deposits, market quotes and the control row. */
  seedWorld(world: GenesisWorld): Promise<void>;

  getSimulationState(): Promise<SimulationStateRecord>;
  setSimulationState(patch: SimulationStatePatch): Promise<SimulationStateRecord>;
  beginTick(input: BeginTickInput): Promise<void>;
  finishTick(input: FinishTickInput): Promise<void>;

  listLocations(): Promise<LocationRecord[]>;
  listResources(): Promise<ResourceRecord[]>;
  updateResource(id: string, patch: { quantity: number }): Promise<ResourceRecord>;
  getMarketPrices(): Promise<MarketPriceRecord[]>;
  setMarketPrice(input: MarketPriceInput): Promise<MarketPriceRecord>;

  listAgents(filter?: AgentFilter): Promise<AgentRecord[]>;
  /** Agents with status "active", sorted by id (the deterministic tick order). */
  listActiveAgents(): Promise<AgentRecord[]>;
  getAgent(id: string): Promise<AgentRecord | null>;
  getAgentByName(name: string): Promise<AgentRecord | null>;
  insertAgent(input: NewAgentInput): Promise<AgentRecord>;
  updateAgent(id: string, patch: AgentPatch): Promise<AgentRecord>;

  getInventory(agentId: string): Promise<InventoryItemRecord[]>;
  /** Never lets a line go below zero: throws AigentiaError INSUFFICIENT_FUNDS. `id` names a new line. */
  adjustInventory(
    agentId: string,
    resourceType: ResourceType,
    locationId: string,
    delta: number,
    id: string,
  ): Promise<InventoryItemRecord>;

  listListings(filter?: ListingFilter): Promise<ListingRecord[]>;
  getListing(id: string): Promise<ListingRecord | null>;
  createListing(input: NewListingInput): Promise<ListingRecord>;
  /** Atomic: decrements quantity only while open and sufficient; null when it cannot be filled. */
  fillListing(listingId: string, quantity: number): Promise<ListingRecord | null>;

  listServices(filter?: ServiceFilter): Promise<ServiceRecord[]>;
  getService(id: string): Promise<ServiceRecord | null>;
  upsertService(input: UpsertServiceInput): Promise<ServiceRecord>;
  recordServiceCall(serviceId: string, call: ServiceCallInput): Promise<ServiceRecord>;

  createInvocation(input: NewInvocationInput): Promise<InvocationRecord>;
  getInvocation(id: string): Promise<InvocationRecord | null>;
  getInvocationByInvoice(invoiceId: string): Promise<InvocationRecord | null>;
  updateInvocation(id: string, patch: InvocationPatch): Promise<InvocationRecord>;

  listOpenJobs(): Promise<JobRecord[]>;
  /** Jobs the agent posted or claimed, any status. */
  listAgentJobs(agentId: string): Promise<JobRecord[]>;
  getJob(id: string): Promise<JobRecord | null>;
  createJob(input: NewJobInput): Promise<JobRecord>;
  /** Atomic claim: true only when the job was still open. */
  claimJob(jobId: string, agentId: string, tick: number): Promise<boolean>;
  submitJob(jobId: string, submission: Record<string, unknown>, tick: number): Promise<JobRecord>;
  completeJob(jobId: string, paymentId: string | null): Promise<JobRecord>;
  failJob(jobId: string): Promise<JobRecord>;
  /** Open or claimed jobs whose `expiresAtTick <= tick` become "expired". */
  expireJobs(tick: number): Promise<JobRecord[]>;

  recordPaymentIntent(input: NewPaymentIntentInput): Promise<PaymentIntentRecord>;
  /** Throws AigentiaError CONFLICT on a duplicate txHash or invoiceId. */
  recordPayment(input: NewPaymentInput): Promise<PaymentRecord>;
  /** Throws AigentiaError CONFLICT when the patch sets a txHash another payment already holds. */
  updatePayment(id: string, patch: PaymentPatch): Promise<PaymentRecord>;
  getPayment(id: string): Promise<PaymentRecord | null>;
  listPaymentsForAgent(agentId: string, limit?: number): Promise<PaymentRecord[]>;
  /** Outgoing XRP the agent sent (status submitted or validated) created at or after `since`. */
  sumSpentSince(agentId: string, since: Date): Promise<bigint>;

  recordTrade(input: NewTradeInput): Promise<TradeRecord>;
  listTrades(filter?: TradeFilter): Promise<TradeRecord[]>;

  recordDecision(input: NewDecisionInput): Promise<DecisionRecord>;
  updateDecision(id: string, patch: DecisionPatch): Promise<DecisionRecord>;
  listDecisions(agentId: string, limit?: number): Promise<DecisionRecord[]>;

  appendEvents(events: readonly WorldEventInput[]): Promise<WorldEvent[]>;
  /** Most recent events, oldest first. */
  recentEvents(limit: number, filter?: EventFilter): Promise<WorldEvent[]>;

  /** Records the event and sets the agent's reputation to `input.next`. */
  addReputationEvent(
    input: ReputationEventInput,
  ): Promise<{ event: ReputationEventRecord; agent: AgentRecord }>;
  listReputationEvents(agentId: string, limit?: number): Promise<ReputationEventRecord[]>;

  snapshotAgent(input: AgentSnapshotInput): Promise<void>;
  listSnapshots(agentId: string, limit?: number): Promise<AgentSnapshotRecord[]>;

  getKnowledge(agentId: string): Promise<KnowledgeEntry[]>;
  /** Merge entries (newest per resource/location wins), bounded; returns the stored list. */
  addKnowledge(agentId: string, entries: readonly KnowledgeEntry[]): Promise<KnowledgeEntry[]>;

  transaction<T>(fn: (tx: WorldStore) => Promise<T>): Promise<T>;
}
