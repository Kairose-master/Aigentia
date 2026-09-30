import { computeNetWorthDrops } from "@aigentia/economy";
import {
  TREASURY_NAME,
  type AgentRecord,
  type DecisionRecord,
  type InventoryItemRecord,
  type JobRecord,
  type LocationRecord,
  type MarketPriceRecord,
  type PaymentRecord,
  type ResourceRecord,
  type ServiceRecord,
  type TickResult,
} from "@aigentia/game-engine";
import {
  experimentConfigSchema,
  experimentResultsSchema,
  type AgentProfileDto,
  type AgentSummaryDto,
  type DecisionTraceDto,
  type ExperimentDto,
  type JobDto,
  type PaymentDto,
  type ServiceListingDto,
  type StatsDto,
  type WorldDto,
} from "@aigentia/protocol";
import { SERVICE_KIND_CATEGORY } from "@aigentia/shared";
import { explorerAccountUrl, explorerTxUrl } from "@aigentia/xrpl";
import type { ExperimentRecord, PaymentTotals } from "./read-model";

/** Everything a mapper needs that is not on the record itself. */
export interface DtoContext {
  readonly ledger: "testnet" | "mock";
  /** XRPL_EXPLORER_URL; only used for testnet links. */
  readonly explorerBase: string;
  /** Treasury wallet address, so funding payments get a sender name. */
  readonly treasuryAddress: string;
  /** Agent id → display name. */
  readonly names: ReadonlyMap<string, string>;
}

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const dropsOrNull = (v: bigint | null): string | null => (v === null ? null : v.toString());

/** Explorer link for a transaction hash: only real ledgers have one; mock receipts get null. */
export function txExplorerUrl(
  ctx: Pick<DtoContext, "ledger" | "explorerBase">,
  txHash: string | null,
): string | null {
  if (txHash === null || ctx.ledger !== "testnet") return null;
  return explorerTxUrl(ctx.explorerBase, txHash);
}

/**
 * Explorer link for an account. `agentSummaryDto.explorerUrl` is a plain string, so the
 * mock ledger yields "" (the web falls back to a local label for mock addresses).
 */
export function accountExplorerUrl(
  ctx: Pick<DtoContext, "ledger" | "explorerBase">,
  address: string,
): string {
  return ctx.ledger === "testnet" ? explorerAccountUrl(ctx.explorerBase, address) : "";
}

export function agentNames(
  agents: readonly Pick<AgentRecord, "id" | "name">[],
): Map<string, string> {
  return new Map(agents.map((a) => [a.id, a.name]));
}

/** Brain label as shown to spectators: the model for llm agents, the kind otherwise. */
export function brainLabel(agent: Pick<AgentRecord, "brain" | "brainModel">): string {
  return agent.brainModel && agent.brainModel.trim().length > 0 ? agent.brainModel : agent.brain;
}

export function netWorthOf(
  agent: Pick<AgentRecord, "balanceDrops">,
  inventory: readonly InventoryItemRecord[],
  prices: readonly MarketPriceRecord[],
): bigint {
  const marketPrices: Record<string, { bidDrops: bigint }> = {};
  for (const p of prices) marketPrices[p.resourceType] = { bidDrops: p.bidDrops };
  return computeNetWorthDrops({
    balanceDrops: agent.balanceDrops,
    inventory: inventory.map((i) => ({ resourceType: i.resourceType, quantity: i.quantity })),
    marketPrices,
  });
}

export function agentSummaryDto(
  agent: AgentRecord,
  netWorthDrops: bigint,
  ctx: Pick<DtoContext, "ledger" | "explorerBase">,
): AgentSummaryDto {
  return {
    id: agent.id,
    name: agent.name,
    objective: agent.objective,
    status: agent.status,
    walletAddress: agent.walletAddress,
    balanceDrops: agent.balanceDrops.toString(),
    netWorthDrops: netWorthDrops.toString(),
    reputation: agent.reputation,
    locationId: agent.locationId,
    brain: brainLabel(agent),
    experimentId: agent.experimentId,
    createdAt: iso(agent.createdAt),
    explorerUrl: accountExplorerUrl(ctx, agent.walletAddress),
  };
}

export function decisionTraceDto(
  d: DecisionRecord,
  ctx: Pick<DtoContext, "ledger" | "explorerBase">,
): DecisionTraceDto {
  return {
    id: d.id,
    tick: d.tick,
    observationSummary: d.observationSummary,
    action: d.action,
    summary: d.summary,
    reason: d.reason,
    costDrops: dropsOrNull(d.costDrops),
    txHash: d.txHash,
    explorerUrl: txExplorerUrl(ctx, d.txHash),
    outcome: d.outcome,
    outcomeStatus: d.outcomeStatus,
    brain: d.brain,
    latencyMs: d.latencyMs,
    createdAt: iso(d.createdAt),
  };
}

function nameOf(ctx: Pick<DtoContext, "names">, agentId: string | null): string | null {
  return agentId === null ? null : (ctx.names.get(agentId) ?? null);
}

export function paymentDto(p: PaymentRecord, ctx: DtoContext): PaymentDto {
  const senderName =
    p.senderAgentId === null
      ? p.senderAddress === ctx.treasuryAddress
        ? TREASURY_NAME
        : null
      : nameOf(ctx, p.senderAgentId);
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    senderAgentId: p.senderAgentId,
    senderName,
    receiverAgentId: p.receiverAgentId,
    receiverName: nameOf(ctx, p.receiverAgentId),
    senderAddress: p.senderAddress,
    receiverAddress: p.receiverAddress,
    amountDrops: p.amountDrops.toString(),
    asset: p.asset,
    txHash: p.txHash,
    ledgerIndex: p.ledgerIndex,
    explorerUrl: txExplorerUrl({ ledger: p.ledger, explorerBase: ctx.explorerBase }, p.txHash),
    ledger: p.ledger,
    invoiceId: p.invoiceId,
    actionRef:
      p.actionKind !== null && p.actionId !== null ? { kind: p.actionKind, id: p.actionId } : null,
    error: p.error,
    createdAt: iso(p.createdAt),
    validatedAt: isoOrNull(p.validatedAt),
  };
}

export function avgLatencyMs(s: Pick<ServiceRecord, "latencySumMs" | "latencyCount">): number {
  return s.latencyCount > 0 ? Number(s.latencySumMs) / s.latencyCount : 0;
}

export function serviceListingDto(
  s: ServiceRecord,
  seller: Pick<AgentRecord, "name" | "reputation">,
  score: number,
): ServiceListingDto {
  return {
    id: s.id,
    kind: s.kind,
    category: SERVICE_KIND_CATEGORY[s.kind],
    description: s.description,
    endpoint: s.endpoint,
    sellerAgentId: s.sellerAgentId,
    sellerName: seller.name,
    sellerReputation: seller.reputation,
    priceDrops: s.priceDrops.toString(),
    successfulCalls: s.successfulCalls,
    failedCalls: s.failedCalls,
    avgLatencyMs: avgLatencyMs(s),
    totalRevenueDrops: s.totalRevenueDrops.toString(),
    score,
    status: s.status,
    lastCalledAt: isoOrNull(s.lastCalledAt),
    createdAt: iso(s.createdAt),
  };
}

export function jobDto(
  j: JobRecord,
  ctx: Pick<DtoContext, "names">,
  txHash: string | null = null,
): JobDto {
  return {
    id: j.id,
    title: j.title,
    description: j.description,
    rewardDrops: j.rewardDrops.toString(),
    status: j.status,
    posterAgentId: j.posterAgentId,
    posterName: ctx.names.get(j.posterAgentId) ?? j.posterAgentId,
    claimedByAgentId: j.claimedByAgentId,
    claimedByName: nameOf(ctx, j.claimedByAgentId),
    requirement: j.requirement,
    paymentId: j.paymentId,
    txHash,
    createdAtTick: j.createdAtTick,
    expiresAtTick: j.expiresAtTick,
    createdAt: iso(j.createdAt),
  };
}

export interface StatsInput {
  readonly agents: number;
  readonly activeAgents: number;
  readonly totals: PaymentTotals;
  readonly activeJobs: number;
  readonly tick: number;
  readonly ledger: "testnet" | "mock";
  readonly network: string;
  readonly now: Date;
}

export function statsDto(input: StatsInput): StatsDto {
  return {
    agents: input.agents,
    activeAgents: input.activeAgents,
    transactions: input.totals.validated,
    servicePurchases: input.totals.servicePurchases,
    activeJobs: input.activeJobs,
    volumeDrops: input.totals.volumeDrops.toString(),
    tick: input.tick,
    ledger: input.ledger,
    network: input.network,
    updatedAt: iso(input.now),
  };
}

export function worldDto(input: {
  tick: number;
  locations: readonly LocationRecord[];
  resources: readonly ResourceRecord[];
  marketPrices: readonly MarketPriceRecord[];
  agents: readonly AgentSummaryDto[];
}): WorldDto {
  const marketPrices: WorldDto["marketPrices"] = {};
  for (const p of input.marketPrices) {
    marketPrices[p.resourceType] = {
      bidDrops: p.bidDrops.toString(),
      askDrops: p.askDrops.toString(),
      supply: p.supply,
    };
  }
  return {
    tick: input.tick,
    locations: input.locations.map((l) => ({ id: l.id, name: l.name, x: l.x, y: l.y })),
    resources: input.resources.map((r) => ({
      id: r.id,
      resourceType: r.resourceType,
      locationId: r.locationId,
      quantity: r.quantity,
      basePriceDrops: r.basePriceDrops.toString(),
    })),
    marketPrices,
    agents: [...input.agents],
  };
}

export function experimentDto(e: ExperimentRecord, agentCount: number): ExperimentDto {
  const results = e.results === null ? null : experimentResultsSchema.parse(e.results);
  return {
    id: e.id,
    name: e.name,
    status: e.status,
    config: experimentConfigSchema.parse(e.config),
    startedAt: isoOrNull(e.startedAt),
    endsAt: isoOrNull(e.endsAt),
    finishedAt: isoOrNull(e.finishedAt),
    results,
    agentCount,
    createdAt: iso(e.createdAt),
  };
}

export function agentProfileDto(input: {
  agent: AgentSummaryDto;
  budgetPolicy: AgentRecord["budgetPolicy"];
  inventory: readonly InventoryItemRecord[];
  services: readonly ServiceListingDto[];
  jobs: readonly JobDto[];
  payments: readonly PaymentDto[];
  decisions: readonly DecisionTraceDto[];
  reputation: readonly { tick: number; delta: number; reason: string; createdAt: Date }[];
  snapshots: readonly { tick: number; balanceDrops: bigint; netWorthDrops: bigint }[];
}): AgentProfileDto {
  return {
    agent: input.agent,
    budgetPolicy: input.budgetPolicy,
    inventory: input.inventory
      .filter((i) => i.quantity > 0)
      .map((i) => ({
        resourceType: i.resourceType,
        quantity: i.quantity,
        locationId: i.locationId,
      })),
    services: [...input.services],
    jobs: [...input.jobs],
    payments: [...input.payments],
    decisions: [...input.decisions],
    reputationHistory: input.reputation.map((r) => ({
      tick: r.tick,
      delta: r.delta,
      reason: r.reason,
      createdAt: iso(r.createdAt),
    })),
    balanceHistory: [...input.snapshots]
      .sort((a, b) => a.tick - b.tick)
      .map((s) => ({
        tick: s.tick,
        balanceDrops: s.balanceDrops.toString(),
        netWorthDrops: s.netWorthDrops.toString(),
      })),
  };
}

/** Wire shape of the simulation control row (admin start/stop and /health). */
export interface SimulationStateDto {
  readonly running: boolean;
  readonly currentTick: number;
  readonly seed: string;
  readonly ledger: "testnet" | "mock";
  readonly tickSeconds: number;
  readonly lastTickAt: string | null;
}

export function simulationStateDto(s: {
  running: boolean;
  currentTick: number;
  seed: string;
  ledger: "testnet" | "mock";
  tickSeconds: number;
  lastTickAt: Date | null;
}): SimulationStateDto {
  return {
    running: s.running,
    currentTick: s.currentTick,
    seed: s.seed,
    ledger: s.ledger,
    tickSeconds: s.tickSeconds,
    lastTickAt: isoOrNull(s.lastTickAt),
  };
}

/** Summary of one admin-triggered tick (POST /api/admin/sim/tick). */
export interface TickSummaryDto {
  readonly tick: number;
  readonly agentsProcessed: number;
  readonly decisionCount: number;
  readonly eventCount: number;
  readonly errors: readonly { agentId: string | null; error: string }[];
  readonly bankrupt: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly decisions: readonly {
    agentId: string;
    agentName: string;
    decisionId: string;
    actionType: string;
    summary: string;
    outcomeStatus: string;
    outcome: string;
    costDrops: string | null;
    txHash: string | null;
    latencyMs: number;
    failedClosed: boolean;
  }[];
}

export function tickSummaryDto(r: TickResult): TickSummaryDto {
  return {
    tick: r.tick,
    agentsProcessed: r.agentsProcessed,
    decisionCount: r.decisions.length,
    eventCount: r.events.length,
    errors: r.errors.map((e) => ({ agentId: e.agentId, error: e.error })),
    bankrupt: [...r.bankrupt],
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    decisions: r.decisions.map((d) => ({
      agentId: d.agentId,
      agentName: d.agentName,
      decisionId: d.decisionId,
      actionType: d.action.type,
      summary: d.summary,
      outcomeStatus: d.outcomeStatus,
      outcome: d.outcome,
      costDrops: d.costDrops === undefined ? null : d.costDrops.toString(),
      txHash: d.txHash ?? null,
      latencyMs: d.latencyMs,
      failedClosed: d.failedClosed,
    })),
  };
}
