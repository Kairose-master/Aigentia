import {
  budgetHeadroom,
  computeNetWorthDrops,
  spentInWindows,
  successRate,
  type RankableService,
  type ServiceRanker,
  type SpendTracker,
} from "@aigentia/economy";
import { observationSchema, type Observation, type ObservedJob } from "@aigentia/protocol";
import { SERVICE_KINDS } from "@aigentia/shared";
import type { BalanceSnapshot } from "@aigentia/xrpl";
import type { BalanceSource } from "./context";
import { knowledgeFromStrategy } from "./store/knowledge";
import type {
  AgentRecord,
  InventoryItemRecord,
  JobRecord,
  ServiceRecord,
  WorldStore,
} from "./store/types";

export const OBSERVATION_LIMITS = {
  nearbyAgents: 12,
  recentEvents: 15,
} as const;

export interface ObservationDeps {
  readonly balances: BalanceSource;
  readonly spendTracker: SpendTracker;
  readonly ranker: ServiceRanker;
  readonly tick: number;
  readonly now: Date;
}

/** The observation plus the live figures the engine itself needs this tick. */
export interface AgentView {
  readonly observation: Observation;
  /** Agent record with the freshly cached balance. */
  readonly agent: AgentRecord;
  readonly balance: BalanceSnapshot;
  readonly inventory: InventoryItemRecord[];
  readonly netWorthDrops: bigint;
}

function observedJob(job: JobRecord, names: Map<string, string>): ObservedJob {
  return {
    id: job.id,
    posterAgentId: job.posterAgentId,
    posterName: names.get(job.posterAgentId) ?? job.posterAgentId,
    title: job.title,
    description: job.description,
    rewardDrops: job.rewardDrops.toString(),
    status: job.status,
    claimedByAgentId: job.claimedByAgentId,
    requirement: job.requirement,
    expiresAtTick: job.expiresAtTick,
  };
}

/**
 * The services table stores `lastCalledAt` (wall-clock), not a tick, and freshness only
 * needs a tick-ish age: a service that has ever been called counts as called this tick
 * (deterministic, clock-independent); one never called keeps the ranker's "unknown" value.
 */
function rankable(service: ServiceRecord, reputation: number, tick: number): RankableService {
  const lastCalledTick = service.lastCalledAt === null ? null : tick;
  return {
    id: service.id,
    kind: service.kind,
    sellerAgentId: service.sellerAgentId,
    priceDrops: service.priceDrops,
    successfulCalls: service.successfulCalls,
    failedCalls: service.failedCalls,
    reputation,
    avgLatencyMs:
      service.latencyCount > 0 ? Number(service.latencySumMs) / service.latencyCount : 0,
    lastCalledTick,
  };
}

/**
 * Rank every foreign active service: each kind is ranked against itself (relevance 1) and
 * the lists are merged by score. Deterministic: the ranker breaks ties by id.
 */
export function rankServices(
  services: readonly ServiceRecord[],
  reputations: ReadonlyMap<string, number>,
  ranker: ServiceRanker,
  tick: number,
): Observation["availableServices"] {
  const out: Observation["availableServices"] = [];
  const byId = new Map(services.map((s) => [s.id, s]));
  for (const kind of SERVICE_KINDS) {
    const candidates = services
      .filter((s) => s.kind === kind)
      .map((s) => rankable(s, reputations.get(s.sellerAgentId) ?? 50, tick));
    for (const ranked of ranker.rank(candidates, { taskKind: kind, tick })) {
      const s = byId.get(ranked.id);
      if (!s) continue;
      out.push({
        id: s.id,
        kind: s.kind,
        sellerAgentId: s.sellerAgentId,
        sellerName: s.sellerAgentId,
        priceDrops: s.priceDrops.toString(),
        description: s.description,
        successRate: successRate(s.successfulCalls, s.failedCalls),
        reputation: ranked.reputation,
        avgLatencyMs: ranked.avgLatencyMs,
        totalCalls: s.successfulCalls + s.failedCalls,
        score: ranked.score,
      });
    }
  }
  return out.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.id < b.id ? -1 : 1));
}

/**
 * Everything an agent can see this tick, validated against `observationSchema`. Also
 * refreshes the agent's cached balance from the BalanceSource.
 */
export async function observeAgent(
  agent: AgentRecord,
  store: WorldStore,
  deps: ObservationDeps,
): Promise<AgentView> {
  const balance = await deps.balances.getBalanceDrops(agent.walletAddress);
  const cached =
    balance.balanceDrops === agent.balanceDrops
      ? agent
      : await store.updateAgent(agent.id, {
          balanceDrops: balance.balanceDrops,
          balanceCheckedAt: deps.now,
        });

  const [agents, inventory, services, myServices, openJobs, myJobs, listings, prices, events] =
    await Promise.all([
      store.listAgents(),
      store.getInventory(agent.id),
      store.listServices({ status: "active" }),
      store.listServices({ sellerAgentId: agent.id }),
      store.listOpenJobs(),
      store.listAgentJobs(agent.id),
      store.listListings({ status: "open" }),
      store.getMarketPrices(),
      store.recentEvents(OBSERVATION_LIMITS.recentEvents),
    ]);
  const spent = await spentInWindows(deps.spendTracker, agent.id, deps.now);
  const headroom = budgetHeadroom(cached.budgetPolicy, spent);

  const names = new Map(agents.map((a) => [a.id, a.name]));
  const reputations = new Map(agents.map((a) => [a.id, a.reputation]));
  const marketPrices = Object.fromEntries(
    prices.map((p) => [
      p.resourceType,
      { bidDrops: p.bidDrops.toString(), askDrops: p.askDrops.toString(), supply: p.supply },
    ]),
  ) as Observation["marketPrices"];
  const netWorthDrops = computeNetWorthDrops({
    balanceDrops: balance.balanceDrops,
    inventory: inventory.map((i) => ({ resourceType: i.resourceType, quantity: i.quantity })),
    marketPrices: Object.fromEntries(prices.map((p) => [p.resourceType, { bidDrops: p.bidDrops }])),
  });

  const availableServices = rankServices(
    services.filter((s) => s.sellerAgentId !== agent.id),
    reputations,
    deps.ranker,
    deps.tick,
  ).map((s) => ({ ...s, sellerName: names.get(s.sellerAgentId) ?? s.sellerAgentId }));

  const servicesByAgent = new Map<string, ServiceRecord["kind"][]>();
  for (const s of services) {
    const list = servicesByAgent.get(s.sellerAgentId) ?? [];
    list.push(s.kind);
    servicesByAgent.set(s.sellerAgentId, list);
  }
  const nearbyAgents = agents
    .filter((a) => a.id !== agent.id && a.status === "active")
    .sort((a, b) => {
      const sameA = a.locationId === cached.locationId ? 0 : 1;
      const sameB = b.locationId === cached.locationId ? 0 : 1;
      if (sameA !== sameB) return sameA - sameB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, OBSERVATION_LIMITS.nearbyAgents)
    .map((a) => ({
      id: a.id,
      name: a.name,
      objective: a.objective,
      reputation: a.reputation,
      locationId: a.locationId,
      status: a.status,
      servicesOffered: [...(servicesByAgent.get(a.id) ?? [])].sort(),
    }));

  const memoryRaw = cached.strategy["memory"];
  const memory =
    memoryRaw !== null && typeof memoryRaw === "object" && !Array.isArray(memoryRaw)
      ? (memoryRaw as Record<string, unknown>)
      : {};

  const observation = observationSchema.parse({
    tick: deps.tick,
    agentId: cached.id,
    name: cached.name,
    objective: cached.objective,
    status: cached.status,
    walletAddress: cached.walletAddress,
    balanceDrops: balance.balanceDrops.toString(),
    spendableDrops: balance.spendableDrops.toString(),
    netWorthDrops: netWorthDrops.toString(),
    reputation: cached.reputation,
    locationId: cached.locationId,
    inventory: inventory
      .filter((i) => i.quantity > 0)
      .map((i) => ({
        resourceType: i.resourceType,
        quantity: i.quantity,
        locationId: i.locationId,
      })),
    budget: {
      maxSpendPerActionDrops: cached.budgetPolicy.maxSpendPerActionDrops,
      remainingHourDrops: headroom.remainingHourDrops.toString(),
      remainingDayDrops: headroom.remainingDayDrops.toString(),
      minimumBalanceDrops: cached.budgetPolicy.minimumBalanceDrops,
      allowedServiceCategories: [...cached.budgetPolicy.allowedServiceCategories],
    },
    myServices: myServices.map((s) => ({
      id: s.id,
      kind: s.kind,
      priceDrops: s.priceDrops.toString(),
      totalCalls: s.successfulCalls + s.failedCalls,
      revenueDrops: s.totalRevenueDrops.toString(),
    })),
    myJobs: myJobs
      .filter((j) => j.status === "open" || j.status === "claimed" || j.status === "submitted")
      .map((j) => observedJob(j, names)),
    availableServices,
    availableJobs: openJobs
      .filter((j) => j.posterAgentId !== agent.id && j.expiresAtTick > deps.tick)
      .map((j) => observedJob(j, names)),
    resourceListings: listings
      .filter((l) => l.quantity > 0)
      .map((l) => ({
        id: l.id,
        sellerAgentId: l.sellerAgentId,
        resourceType: l.resourceType,
        quantity: l.quantity,
        unitPriceDrops: l.unitPriceDrops.toString(),
      })),
    marketPrices,
    nearbyAgents,
    recentEvents: events.map((e) => ({
      tick: e.tick,
      type: e.type,
      message: e.message,
      agentId: e.agentId,
      counterpartyId: e.counterpartyId,
    })),
    memory,
    knowledge: knowledgeFromStrategy(cached.strategy),
  });

  return { observation, agent: cached, balance, inventory, netWorthDrops };
}

/** Observation only (see `observeAgent` for the balance and net worth alongside it). */
export async function buildObservation(
  agent: AgentRecord,
  store: WorldStore,
  deps: ObservationDeps,
): Promise<Observation> {
  return (await observeAgent(agent, store, deps)).observation;
}
