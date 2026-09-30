import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { BudgetPolicy, ExperimentConfig, ExperimentResults } from "@aigentia/protocol";
import {
  agentStatusEnum,
  bountyStatusEnum,
  brainKindEnum,
  decisionOutcomeEnum,
  experimentStatusEnum,
  invocationStatusEnum,
  jobStatusEnum,
  ledgerKindEnum,
  listingStatusEnum,
  objectiveEnum,
  paymentKindEnum,
  paymentStatusEnum,
  resourceTypeEnum,
  serviceKindEnum,
  serviceStatusEnum,
} from "./enums";

/**
 * Money columns are `bigint` drops stored as `mode: "bigint"` (1 XRP = 1,000,000 drops).
 * Wallet SEEDS ARE NEVER STORED HERE — agents carry only a public address and an opaque
 * `walletRef` resolved by the WalletProvider.
 */
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const experiments = pgTable("experiments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: experimentStatusEnum("status").notNull().default("draft"),
  config: jsonb("config").$type<ExperimentConfig>().notNull(),
  seed: text("seed").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  startTick: integer("start_tick"),
  endTick: integer("end_tick"),
  results: jsonb("results").$type<ExperimentResults>(),
  ...timestamps,
});

export const locations = pgTable("locations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
});

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    objective: objectiveEnum("objective").notNull(),
    status: agentStatusEnum("status").notNull().default("active"),
    brain: brainKindEnum("brain").notNull().default("deterministic"),
    /** Model identifier for llm brains, e.g. "anthropic/claude-sonnet-5-5". */
    brainModel: text("brain_model"),
    /** Public classic address; the seed lives with the WalletProvider, never here. */
    walletAddress: text("wallet_address").notNull(),
    walletRef: text("wallet_ref").notNull(),
    /** Cached ledger balance (drops). Source of truth is the XRPL; refreshed by BalanceReader. */
    balanceDrops: bigint("balance_drops", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    balanceCheckedAt: timestamp("balance_checked_at", { withTimezone: true }),
    reputation: doublePrecision("reputation").notNull().default(50),
    /** Free-form strategy state written by reflectOnOutcome (memory, heuristics). */
    strategy: jsonb("strategy").$type<Record<string, unknown>>().notNull().default({}),
    budgetPolicy: jsonb("budget_policy").$type<BudgetPolicy>().notNull(),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id),
    experimentId: text("experiment_id").references(() => experiments.id),
    startingCapitalDrops: bigint("starting_capital_drops", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    lastTick: integer("last_tick"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("agents_name_idx").on(t.name),
    uniqueIndex("agents_wallet_address_idx").on(t.walletAddress),
    index("agents_experiment_idx").on(t.experimentId),
    index("agents_status_idx").on(t.status),
  ],
);

export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id),
    quantity: integer("quantity").notNull().default(0),
    basePriceDrops: bigint("base_price_drops", { mode: "bigint" }).notNull(),
    regenPerTick: integer("regen_per_tick").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("resources_type_location_idx").on(t.resourceType, t.locationId)],
);

/** World-market quotes per resource type (deterministic price model). */
export const marketPrices = pgTable("market_prices", {
  resourceType: resourceTypeEnum("resource_type").primaryKey(),
  bidDrops: bigint("bid_drops", { mode: "bigint" }).notNull(),
  askDrops: bigint("ask_drops", { mode: "bigint" }).notNull(),
  supply: integer("supply").notNull().default(0),
  lastTick: integer("last_tick").notNull().default(0),
  history: jsonb("history")
    .$type<{ tick: number; bidDrops: string; askDrops: string }[]>()
    .notNull()
    .default([]),
});

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id),
    quantity: integer("quantity").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("inventory_agent_type_location_idx").on(t.agentId, t.resourceType, t.locationId),
  ],
);

export const resourceListings = pgTable(
  "resource_listings",
  {
    id: text("id").primaryKey(),
    sellerAgentId: text("seller_agent_id")
      .notNull()
      .references(() => agents.id),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceDrops: bigint("unit_price_drops", { mode: "bigint" }).notNull(),
    status: listingStatusEnum("status").notNull().default("open"),
    tick: integer("tick").notNull(),
    ...timestamps,
  },
  (t) => [index("listings_status_idx").on(t.status, t.resourceType)],
);

export const services = pgTable(
  "services",
  {
    id: text("id").primaryKey(),
    sellerAgentId: text("seller_agent_id")
      .notNull()
      .references(() => agents.id),
    kind: serviceKindEnum("kind").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    endpoint: text("endpoint").notNull(),
    priceDrops: bigint("price_drops", { mode: "bigint" }).notNull(),
    asset: text("asset").notNull().default("XRP"),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>().notNull(),
    status: serviceStatusEnum("status").notNull().default("active"),
    successfulCalls: integer("successful_calls").notNull().default(0),
    failedCalls: integer("failed_calls").notNull().default(0),
    totalRevenueDrops: bigint("total_revenue_drops", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    latencySumMs: bigint("latency_sum_ms", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    latencyCount: integer("latency_count").notNull().default(0),
    lastCalledAt: timestamp("last_called_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("services_seller_kind_idx").on(t.sellerAgentId, t.kind),
    index("services_kind_status_idx").on(t.kind, t.status),
  ],
);

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    purpose: paymentKindEnum("purpose").notNull(),
    destinationAddress: text("destination_address").notNull(),
    destinationAgentId: text("destination_agent_id").references(() => agents.id),
    asset: text("asset").notNull().default("XRP"),
    amountDrops: bigint("amount_drops", { mode: "bigint" }).notNull(),
    serviceCategory: text("service_category"),
    actionKind: text("action_kind").notNull(),
    actionId: text("action_id").notNull(),
    approved: boolean("approved").notNull(),
    policyDecision: jsonb("policy_decision").$type<Record<string, unknown>>().notNull(),
    tick: integer("tick").notNull(),
    ...timestamps,
  },
  (t) => [index("intents_agent_idx").on(t.agentId, t.createdAt)],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    intentId: text("intent_id").references(() => paymentIntents.id),
    kind: paymentKindEnum("kind").notNull(),
    status: paymentStatusEnum("status").notNull(),
    ledger: ledgerKindEnum("ledger").notNull(),
    senderAgentId: text("sender_agent_id").references(() => agents.id),
    receiverAgentId: text("receiver_agent_id").references(() => agents.id),
    senderAddress: text("sender_address").notNull(),
    receiverAddress: text("receiver_address").notNull(),
    asset: text("asset").notNull().default("XRP"),
    amountDrops: bigint("amount_drops", { mode: "bigint" }).notNull(),
    feeDrops: bigint("fee_drops", { mode: "bigint" }),
    /** Unique: one ledger transaction can settle exactly one game payment. */
    txHash: text("tx_hash"),
    ledgerIndex: integer("ledger_index"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    invoiceId: text("invoice_id"),
    actionKind: text("action_kind"),
    actionId: text("action_id"),
    tick: integer("tick").notNull(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("payments_tx_hash_idx").on(t.txHash),
    uniqueIndex("payments_invoice_idx").on(t.invoiceId),
    index("payments_sender_idx").on(t.senderAgentId, t.createdAt),
    index("payments_receiver_idx").on(t.receiverAgentId, t.createdAt),
    index("payments_status_idx").on(t.status),
  ],
);

/** On-ledger transactions observed for tracked addresses (TransactionIndexer). */
export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    txHash: text("tx_hash").primaryKey(),
    ledger: ledgerKindEnum("ledger").notNull(),
    transactionType: text("transaction_type").notNull(),
    senderAddress: text("sender_address").notNull(),
    receiverAddress: text("receiver_address"),
    asset: text("asset").notNull().default("XRP"),
    amountDrops: bigint("amount_drops", { mode: "bigint" }),
    feeDrops: bigint("fee_drops", { mode: "bigint" }),
    ledgerIndex: integer("ledger_index").notNull(),
    closeTime: timestamp("close_time", { withTimezone: true }),
    invoiceId: text("invoice_id"),
    memo: text("memo"),
    result: text("result").notNull(),
    validated: boolean("validated").notNull(),
    paymentId: text("payment_id").references(() => payments.id),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_tx_sender_idx").on(t.senderAddress),
    index("ledger_tx_receiver_idx").on(t.receiverAddress),
  ],
);

export const serviceInvocations = pgTable(
  "service_invocations",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id),
    sellerAgentId: text("seller_agent_id")
      .notNull()
      .references(() => agents.id),
    buyerAgentId: text("buyer_agent_id").references(() => agents.id),
    buyerAddress: text("buyer_address"),
    /** x402 invoice id issued with the 402 quote. Unique → replayed receipts are idempotent. */
    invoiceId: text("invoice_id").notNull(),
    status: invocationStatusEnum("status").notNull().default("quoted"),
    priceDrops: bigint("price_drops", { mode: "bigint" }).notNull(),
    paymentRequirements: jsonb("payment_requirements").$type<Record<string, unknown>>().notNull(),
    paymentId: text("payment_id").references(() => payments.id),
    txHash: text("tx_hash"),
    request: jsonb("request").$type<Record<string, unknown>>().notNull().default({}),
    response: jsonb("response").$type<Record<string, unknown>>(),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    tick: integer("tick").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invocations_invoice_idx").on(t.invoiceId),
    uniqueIndex("invocations_tx_hash_idx").on(t.txHash),
    index("invocations_service_idx").on(t.serviceId, t.createdAt),
    index("invocations_buyer_idx").on(t.buyerAgentId),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    posterAgentId: text("poster_agent_id")
      .notNull()
      .references(() => agents.id),
    title: text("title").notNull(),
    description: text("description").notNull(),
    rewardDrops: bigint("reward_drops", { mode: "bigint" }).notNull(),
    status: jobStatusEnum("status").notNull().default("open"),
    requirement: jsonb("requirement").$type<Record<string, unknown>>(),
    claimedByAgentId: text("claimed_by_agent_id").references(() => agents.id),
    claimedAtTick: integer("claimed_at_tick"),
    submission: jsonb("submission").$type<Record<string, unknown>>(),
    submittedAtTick: integer("submitted_at_tick"),
    paymentId: text("payment_id").references(() => payments.id),
    createdAtTick: integer("created_at_tick").notNull(),
    expiresAtTick: integer("expires_at_tick").notNull(),
    ...timestamps,
  },
  (t) => [index("jobs_status_idx").on(t.status), index("jobs_poster_idx").on(t.posterAgentId)],
);

export const bounties = pgTable("bounties", {
  id: text("id").primaryKey(),
  posterAgentId: text("poster_agent_id")
    .notNull()
    .references(() => agents.id),
  description: text("description").notNull(),
  rewardDrops: bigint("reward_drops", { mode: "bigint" }).notNull(),
  target: jsonb("target").$type<Record<string, unknown>>().notNull(),
  status: bountyStatusEnum("status").notNull().default("open"),
  claimedByAgentId: text("claimed_by_agent_id").references(() => agents.id),
  paymentId: text("payment_id").references(() => payments.id),
  createdAtTick: integer("created_at_tick").notNull(),
  expiresAtTick: integer("expires_at_tick").notNull(),
  ...timestamps,
});

export const trades = pgTable(
  "trades",
  {
    id: text("id").primaryKey(),
    buyerAgentId: text("buyer_agent_id").references(() => agents.id),
    sellerAgentId: text("seller_agent_id").references(() => agents.id),
    /** "market" when the world market is the counterparty. */
    counterparty: text("counterparty").notNull().default("agent"),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceDrops: bigint("unit_price_drops", { mode: "bigint" }).notNull(),
    totalDrops: bigint("total_drops", { mode: "bigint" }).notNull(),
    paymentId: text("payment_id").references(() => payments.id),
    listingId: text("listing_id").references(() => resourceListings.id),
    tick: integer("tick").notNull(),
    ...timestamps,
  },
  (t) => [index("trades_tick_idx").on(t.tick)],
);

export const reputationEvents = pgTable(
  "reputation_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    delta: doublePrecision("delta").notNull(),
    reason: text("reason").notNull(),
    refKind: text("ref_kind"),
    refId: text("ref_id"),
    tick: integer("tick").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reputation_agent_idx").on(t.agentId, t.createdAt)],
);

/** Concise, spectator-safe decision traces. Never hidden chain-of-thought. */
export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    tick: integer("tick").notNull(),
    observationSummary: text("observation_summary").notNull(),
    action: jsonb("action").$type<Record<string, unknown>>().notNull(),
    summary: text("summary").notNull(),
    reason: text("reason").notNull(),
    rationale: jsonb("rationale").$type<Record<string, unknown>>(),
    costDrops: bigint("cost_drops", { mode: "bigint" }),
    paymentId: text("payment_id").references(() => payments.id),
    txHash: text("tx_hash"),
    outcome: text("outcome"),
    outcomeStatus: decisionOutcomeEnum("outcome_status").notNull().default("pending"),
    brain: text("brain").notNull(),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("decisions_agent_tick_idx").on(t.agentId, t.tick),
    index("decisions_tick_idx").on(t.tick),
  ],
);

export const worldEvents = pgTable(
  "world_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tick: integer("tick").notNull(),
    type: text("type").notNull(),
    message: text("message").notNull(),
    agentId: text("agent_id"),
    counterpartyId: text("counterparty_id"),
    experimentId: text("experiment_id"),
    txHash: text("tx_hash"),
    amountDrops: bigint("amount_drops", { mode: "bigint" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_tick_idx").on(t.tick),
    index("events_agent_idx").on(t.agentId),
    index("events_type_idx").on(t.type),
  ],
);

export const ticks = pgTable("ticks", {
  tick: integer("tick").primaryKey(),
  seed: text("seed").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  agentsProcessed: integer("agents_processed").notNull().default(0),
  status: text("status").notNull().default("running"),
  error: text("error"),
});

/** Per-tick snapshot for balance charts and experiment analytics. */
export const agentSnapshots = pgTable(
  "agent_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    tick: integer("tick").notNull(),
    balanceDrops: bigint("balance_drops", { mode: "bigint" }).notNull(),
    netWorthDrops: bigint("net_worth_drops", { mode: "bigint" }).notNull(),
    reputation: doublePrecision("reputation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("snapshots_agent_tick_idx").on(t.agentId, t.tick)],
);

/** Single-row simulation control record. */
export const simulationState = pgTable(
  "simulation_state",
  {
    id: integer("id").primaryKey().default(1),
    running: boolean("running").notNull().default(false),
    currentTick: integer("current_tick").notNull().default(0),
    seed: text("seed").notNull().default("genesis"),
    ledger: ledgerKindEnum("ledger").notNull().default("testnet"),
    tickSeconds: integer("tick_seconds").notNull().default(60),
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    singleton: boolean("singleton").notNull().default(true),
  },
  (t) => [
    uniqueIndex("simulation_state_singleton_idx").on(t.singleton),
    check("simulation_state_id_check", sql`${t.id} = 1`),
  ],
);
