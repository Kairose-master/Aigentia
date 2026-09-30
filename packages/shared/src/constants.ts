/**
 * Canonical enumerations shared by the protocol, the database schema and the UI.
 * Keep these as `as const` tuples so Zod enums and Drizzle enums derive from one source.
 */

export const OBJECTIVES = [
  "maximize_net_worth",
  "survive",
  "maximize_information",
  "maximize_reputation",
  "build_coalition",
  "information_broker",
  "profitable_service",
] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const ACTION_TYPES = [
  "WAIT",
  "BUY_SERVICE",
  "SELL_SERVICE",
  "POST_JOB",
  "ACCEPT_JOB",
  "SUBMIT_JOB",
  "TRANSFER",
  "BUY_RESOURCE",
  "SELL_RESOURCE",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const SERVICE_KINDS = ["SCOUT", "ANALYST", "COURIER"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const SERVICE_CATEGORIES = ["intelligence", "analysis", "logistics"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const SERVICE_KIND_CATEGORY: Record<ServiceKind, ServiceCategory> = {
  SCOUT: "intelligence",
  ANALYST: "analysis",
  COURIER: "logistics",
};

export const AGENT_STATUSES = ["active", "paused", "bankrupt", "retired"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const RESOURCE_TYPES = ["ore", "data", "energy", "alloy"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const JOB_STATUSES = [
  "open",
  "claimed",
  "submitted",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const BOUNTY_STATUSES = ["open", "claimed", "paid", "cancelled", "expired"] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];

export const PAYMENT_KINDS = [
  "x402",
  "transfer",
  "job_reward",
  "bounty",
  "trade",
  "funding",
] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_STATUSES = ["intent", "denied", "submitted", "validated", "failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const INVOCATION_STATUSES = [
  "quoted",
  "paid",
  "fulfilled",
  "failed",
  "rejected",
  "expired",
] as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

export const EXPERIMENT_STATUSES = ["draft", "running", "finished", "aborted"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const BRAIN_KINDS = ["deterministic", "llm"] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];

export const ASSET_CODES = ["XRP", "RLUSD"] as const;
export type AssetCode = (typeof ASSET_CODES)[number];

/** XRPL network identifiers in CAIP-2 style, as used by x402-xrpl. */
export const XRPL_NETWORKS = {
  mainnet: { caip2: "xrpl:0", networkId: 0 },
  testnet: { caip2: "xrpl:1", networkId: 1 },
  devnet: { caip2: "xrpl:2", networkId: 2 },
} as const;
export type XrplNetworkName = keyof typeof XRPL_NETWORKS;

/** Genesis Sector: the minimal persistent world. */
export const GENESIS_LOCATIONS = [
  { id: "loc_core", name: "Core Station", x: 0, y: 0 },
  { id: "loc_north_belt", name: "North Belt", x: 0, y: 3 },
  { id: "loc_east_relay", name: "East Relay", x: 4, y: 0 },
  { id: "loc_south_forge", name: "South Forge", x: 0, y: -3 },
  { id: "loc_west_archive", name: "West Archive", x: -4, y: 0 },
] as const;
export type LocationId = (typeof GENESIS_LOCATIONS)[number]["id"];

export const WORLD_EVENT_TYPES = [
  "AGENT_CREATED",
  "AGENT_STATUS_CHANGED",
  "TICK_STARTED",
  "TICK_FINISHED",
  "DECISION_MADE",
  "ACTION_INVALID",
  "ACTION_REJECTED",
  "SERVICE_LISTED",
  "SERVICE_QUOTED",
  "SERVICE_PURCHASED",
  "SERVICE_FULFILLED",
  "SERVICE_FAILED",
  "PAYMENT_DENIED",
  "PAYMENT_SUBMITTED",
  "PAYMENT_VALIDATED",
  "PAYMENT_FAILED",
  "TRANSFER_SENT",
  "JOB_POSTED",
  "JOB_CLAIMED",
  "JOB_SUBMITTED",
  "JOB_COMPLETED",
  "JOB_FAILED",
  "BOUNTY_POSTED",
  "BOUNTY_PAID",
  "RESOURCE_BOUGHT",
  "RESOURCE_SOLD",
  "REPUTATION_CHANGED",
  "AGENT_BANKRUPT",
  "EXPERIMENT_STARTED",
  "EXPERIMENT_FINISHED",
] as const;
export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number];

export const ID_PREFIXES = {
  agent: "agt",
  service: "svc",
  invocation: "inv",
  job: "job",
  bounty: "bty",
  trade: "trd",
  payment: "pay",
  intent: "pin",
  decision: "dec",
  experiment: "exp",
  resource: "res",
  inventory: "itm",
  listing: "lst",
  reputation: "rep",
} as const;
export type IdPrefix = keyof typeof ID_PREFIXES;

export const DROPS_PER_XRP = 1_000_000n;
