import {
  GENESIS_LOCATIONS,
  OBJECTIVES,
  RESOURCE_TYPES,
  SERVICE_KINDS,
  SeededRandom,
  deriveSeed,
  deterministicId,
} from "@aigentia/shared";
import type { Objective, ResourceType } from "@aigentia/shared";
import { observationSchema } from "@aigentia/protocol";
import type { Observation } from "@aigentia/protocol";

export interface SyntheticObservationOptions {
  seed?: string;
  tick?: number;
  agentId?: string;
  name?: string;
  objective?: Objective;
  balanceDrops?: bigint;
  memory?: Record<string, unknown>;
  /** Number of foreign services / open jobs / nearby agents to synthesise. */
  services?: number;
  jobs?: number;
  agents?: number;
  listings?: number;
  events?: number;
  knowledge?: number;
  inventory?: { resourceType: ResourceType; quantity: number }[];
  overrides?: Partial<Observation>;
}

const NAMES = ["ATLAS", "ORION", "VEGA", "LYRA", "NOVA", "RIGEL", "CASTOR", "MIRA"];

/**
 * Deterministic synthetic observation that satisfies `observationSchema`. Same options →
 * same observation. Intended for brain and engine tests.
 */
export function syntheticObservation(options: SyntheticObservationOptions = {}): Observation {
  const seed = options.seed ?? "fixture";
  const tick = options.tick ?? 0;
  const rng = new SeededRandom(deriveSeed("obs", seed, tick));
  const agentId = options.agentId ?? deterministicId("agent", `${seed}:self`);
  const objective = options.objective ?? "maximize_net_worth";
  const balance = options.balanceDrops ?? 20_000_000n;
  const reserve = 1_000_000n;
  const spendable = balance > reserve ? balance - reserve : 0n;

  const agentCount = options.agents ?? 4;
  const nearbyAgents = Array.from({ length: agentCount }, (_, i) => ({
    id: deterministicId("agent", `${seed}:agent:${i}`),
    name: `${NAMES[i % NAMES.length]}-${i + 1}`,
    objective: OBJECTIVES[i % OBJECTIVES.length] as Objective,
    reputation: 30 + rng.int(0, 70),
    locationId: GENESIS_LOCATIONS[i % GENESIS_LOCATIONS.length]?.id ?? "loc_core",
    status: "active",
    servicesOffered: [SERVICE_KINDS[i % SERVICE_KINDS.length] as (typeof SERVICE_KINDS)[number]],
  }));

  const serviceCount = options.services ?? 5;
  const availableServices = Array.from({ length: serviceCount }, (_, i) => {
    const seller = nearbyAgents[i % Math.max(1, nearbyAgents.length)];
    const kind = SERVICE_KINDS[i % SERVICE_KINDS.length] as (typeof SERVICE_KINDS)[number];
    const price = BigInt(1_000 + rng.int(0, 60) * 1_000);
    return {
      id: deterministicId("service", `${seed}:service:${i}`),
      kind,
      sellerAgentId: seller?.id ?? deterministicId("agent", `${seed}:orphan`),
      sellerName: seller?.name ?? "GHOST-0",
      priceDrops: price.toString(),
      description: `${kind} service #${i}`,
      successRate: Math.round((0.6 + rng.next() * 0.4) * 100) / 100,
      reputation: 20 + rng.int(0, 80),
      avgLatencyMs: rng.int(50, 900),
      totalCalls: rng.int(0, 40),
      score: Math.round(rng.next() * 1000) / 1000,
    };
  });

  const jobCount = options.jobs ?? 3;
  const requirementKinds = [
    "analysis",
    "report_resource_location",
    "deliver_resource",
    null,
  ] as const;
  const availableJobs = Array.from({ length: jobCount }, (_, i) => {
    const poster = nearbyAgents[i % Math.max(1, nearbyAgents.length)];
    const kind = requirementKinds[i % requirementKinds.length];
    const resourceType = RESOURCE_TYPES[i % RESOURCE_TYPES.length] as ResourceType;
    return {
      id: deterministicId("job", `${seed}:job:${i}`),
      posterAgentId: poster?.id ?? deterministicId("agent", `${seed}:orphan`),
      posterName: poster?.name ?? "GHOST-0",
      title: `Job ${i}: ${kind ?? "general"} ${resourceType}`,
      description: `Synthetic job ${i} for ${resourceType}.`,
      rewardDrops: BigInt(5_000 + rng.int(0, 50) * 2_000).toString(),
      status: "open",
      claimedByAgentId: null,
      requirement: kind === null ? null : { kind, resourceType, quantity: 2 },
      expiresAtTick: tick + 20 + i,
    };
  });

  const marketPrices = Object.fromEntries(
    RESOURCE_TYPES.map((r, i) => {
      const drift = 1 + Math.sin((tick + i * 7) / 5) * 0.2;
      const ask = BigInt(Math.round((3_000 + i * 1_000) * drift));
      return [
        r,
        {
          bidDrops: ((ask * 90n) / 100n).toString(),
          askDrops: ask.toString(),
          supply: 50 + i * 10,
        },
      ];
    }),
  ) as Observation["marketPrices"];

  const listingCount = options.listings ?? 2;
  const resourceListings = Array.from({ length: listingCount }, (_, i) => {
    const seller = nearbyAgents[(i + 1) % Math.max(1, nearbyAgents.length)];
    const resourceType = RESOURCE_TYPES[i % RESOURCE_TYPES.length] as ResourceType;
    const ask = BigInt(marketPrices[resourceType]?.askDrops ?? "3000");
    return {
      id: deterministicId("listing", `${seed}:listing:${i}`),
      sellerAgentId: seller?.id ?? deterministicId("agent", `${seed}:orphan`),
      resourceType,
      quantity: 5 + i,
      unitPriceDrops: ((ask * BigInt(80 + rng.int(0, 40))) / 100n).toString(),
    };
  });

  const eventCount = options.events ?? 4;
  const recentEvents = Array.from({ length: eventCount }, (_, i) => ({
    tick: Math.max(0, tick - eventCount + i),
    type: i % 2 === 0 ? "SERVICE_PURCHASED" : "JOB_POSTED",
    message: `Synthetic event ${i}`,
    agentId: nearbyAgents[i % Math.max(1, nearbyAgents.length)]?.id ?? null,
    counterpartyId: null,
  }));

  const knowledgeCount = options.knowledge ?? 0;
  const knowledge = Array.from({ length: knowledgeCount }, (_, i) => ({
    resourceType: RESOURCE_TYPES[i % RESOURCE_TYPES.length] as ResourceType,
    locationId: GENESIS_LOCATIONS[(i + 1) % GENESIS_LOCATIONS.length]?.id ?? "loc_core",
    quantity: 10 + i * 5,
    learnedAtTick: Math.max(0, tick - i * 3),
  }));

  const inventory = (options.inventory ?? []).map((item) => ({ ...item, locationId: "loc_core" }));

  const obs: Observation = {
    tick,
    agentId,
    name: options.name ?? "SELF-0",
    objective,
    status: "active",
    walletAddress: "rDeterministicFixtureAddress000000",
    balanceDrops: balance.toString(),
    spendableDrops: spendable.toString(),
    netWorthDrops: balance.toString(),
    reputation: 50,
    locationId: "loc_core",
    inventory,
    budget: {
      maxSpendPerActionDrops: "500000",
      remainingHourDrops: "3000000",
      remainingDayDrops: "8000000",
      minimumBalanceDrops: "1500000",
      allowedServiceCategories: ["intelligence", "analysis", "logistics"],
    },
    myServices: [],
    myJobs: [],
    availableServices,
    availableJobs,
    resourceListings,
    marketPrices,
    nearbyAgents,
    recentEvents,
    memory: options.memory ?? {},
    knowledge,
    ...options.overrides,
  };
  return observationSchema.parse(obs);
}
