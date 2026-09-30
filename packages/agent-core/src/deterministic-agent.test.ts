import { describe, expect, it } from "vitest";
import { OBJECTIVES } from "@aigentia/shared";
import type { Objective } from "@aigentia/shared";
import { decisionSchema } from "@aigentia/protocol";
import type { AgentAction, Decision, Observation } from "@aigentia/protocol";
import { DeterministicAgent, spendCapDrops } from "./deterministic-agent";
import type { DecisionResult, ExecutionOutcome } from "./brain";
import { syntheticObservation } from "./testing/fixtures";
import type { SyntheticObservationOptions } from "./testing/fixtures";

const TICKS = 60;

interface RunOptions {
  worldSeed: string;
  objective: Objective;
  seed?: string;
  fixture?: Omit<SyntheticObservationOptions, "tick" | "objective" | "memory" | "seed">;
}

/**
 * Minimal world loop: feeds the brain 60 synthetic observations, carrying memory and a
 * tiny amount of state (listed services, claimed jobs) so strategies have something to
 * react to. Every execution "succeeds" so memory accumulates deterministically.
 */
async function run(
  options: RunOptions,
): Promise<{ results: DecisionResult[]; observations: Observation[] }> {
  const brain = new DeterministicAgent({ worldSeed: options.worldSeed });
  let memory: Record<string, unknown> = {};
  const myServices: Observation["myServices"] = [];
  const myJobs: Observation["myJobs"] = [];
  const inventory: Observation["inventory"] = [];
  const knowledge: Observation["knowledge"] = [];
  const consumedJobIds = new Set<string>();
  const results: DecisionResult[] = [];
  const observations: Observation[] = [];
  for (let tick = 0; tick < TICKS; tick++) {
    const fresh = syntheticObservation({
      ...options.fixture,
      seed: options.seed ?? "world",
      tick,
      objective: options.objective,
      memory,
      overrides: { ...options.fixture?.overrides, myServices: myServices.map((s) => ({ ...s })) },
    });
    const obs: Observation = {
      ...fresh,
      availableJobs: fresh.availableJobs.filter((j) => !consumedJobIds.has(j.id)),
      myJobs: [...(options.fixture?.overrides?.myJobs ?? []), ...myJobs.map((j) => ({ ...j }))],
      inventory: [...fresh.inventory, ...inventory.map((i) => ({ ...i }))],
      knowledge: [...fresh.knowledge, ...knowledge.map((k) => ({ ...k }))],
    };
    observations.push(obs);
    const result = await brain.decide(obs);
    results.push(result);
    const outcome: ExecutionOutcome = { status: "success", outcome: "ok" };
    const action = result.decision.action;
    if (action.type === "ACCEPT_JOB") {
      const job = obs.availableJobs.find((j) => j.id === action.jobId);
      if (job) {
        consumedJobIds.add(job.id);
        myJobs.push({ ...job, status: "claimed", claimedByAgentId: obs.agentId });
      }
    }
    if (action.type === "SUBMIT_JOB") {
      const idx = myJobs.findIndex((j) => j.id === action.jobId);
      if (idx >= 0) myJobs.splice(idx, 1);
    }
    if (action.type === "POST_JOB") {
      myJobs.push({
        id: `job_posted${String(tick).padStart(6, "0")}`,
        posterAgentId: obs.agentId,
        posterName: obs.name,
        title: action.title,
        description: action.description,
        rewardDrops: action.rewardDrops,
        status: "open",
        claimedByAgentId: null,
        requirement: action.requirement ?? null,
        expiresAtTick: tick + action.expiresInTicks,
      });
    }
    if (action.type === "BUY_RESOURCE") {
      const item = inventory.find((i) => i.resourceType === action.resourceType);
      if (item) item.quantity += action.quantity;
      else
        inventory.push({
          resourceType: action.resourceType,
          quantity: action.quantity,
          locationId: "loc_core",
        });
    }
    if (action.type === "SELL_RESOURCE") {
      const item = inventory.find((i) => i.resourceType === action.resourceType);
      if (item) item.quantity = Math.max(0, item.quantity - action.quantity);
    }
    if (action.type === "BUY_SERVICE") {
      const service = obs.availableServices.find((s) => s.id === action.serviceId);
      if (service?.kind === "SCOUT")
        knowledge.push({
          resourceType: "ore",
          locationId: "loc_north_belt",
          quantity: 40,
          learnedAtTick: tick,
        });
    }
    for (const j of myJobs)
      if (j.posterAgentId === obs.agentId && j.expiresAtTick <= tick + 1) j.status = "expired";
    if (result.decision.action.type === "SELL_SERVICE") {
      const a = result.decision.action;
      const existing = myServices.find((s) => s.kind === a.kind);
      if (existing) existing.priceDrops = a.priceDrops;
      else
        myServices.push({
          id: `svc_${a.kind.toLowerCase()}000001`,
          kind: a.kind,
          priceDrops: a.priceDrops,
          totalCalls: 0,
          revenueDrops: "0",
        });
    }
    for (const s of myServices) if (tick % 4 === 0) s.totalCalls += 1;
    memory = await brain.reflectOnOutcome(obs, result.decision, outcome);
  }
  return { results, observations };
}

function serialize(results: DecisionResult[]): string {
  return JSON.stringify(results.map((r) => ({ d: r.decision, f: r.failedClosed })));
}

function spendOf(action: AgentAction): bigint {
  switch (action.type) {
    case "BUY_SERVICE":
      return BigInt(action.maxPriceDrops);
    case "TRANSFER":
      return BigInt(action.amountDrops);
    case "POST_JOB":
      return BigInt(action.rewardDrops);
    case "BUY_RESOURCE":
      return BigInt(action.maxUnitPriceDrops) * BigInt(action.quantity);
    default:
      return 0n;
  }
}

function referencedIds(action: AgentAction): string[] {
  switch (action.type) {
    case "BUY_SERVICE":
      return [action.serviceId];
    case "ACCEPT_JOB":
    case "SUBMIT_JOB":
      return [action.jobId];
    case "TRANSFER":
      return [action.toAgentId];
    case "BUY_RESOURCE":
      return action.listingId === undefined ? [] : [action.listingId];
    default:
      return [];
  }
}

function knownIds(obs: Observation): Set<string> {
  return new Set([
    ...obs.availableServices.map((s) => s.id),
    ...obs.availableJobs.map((j) => j.id),
    ...obs.myJobs.map((j) => j.id),
    ...obs.nearbyAgents.map((a) => a.id),
    ...obs.resourceListings.map((l) => l.id),
  ]);
}

function actionMix(results: DecisionResult[]): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const r of results) mix[r.decision.action.type] = (mix[r.decision.action.type] ?? 0) + 1;
  return mix;
}

describe("DeterministicAgent", () => {
  it("has the deterministic kind and model", () => {
    const brain = new DeterministicAgent({ worldSeed: "s" });
    expect(brain.kind).toBe("deterministic");
    expect(brain.model).toBe("deterministic-v1");
  });

  it("produces identical decisions for identical (seed, observation sequence) over 60 ticks", async () => {
    for (const objective of OBJECTIVES) {
      const a = await run({ worldSeed: "genesis", objective });
      const b = await run({ worldSeed: "genesis", objective });
      expect(serialize(a.results)).toBe(serialize(b.results));
      expect(a.results.every((r) => !r.failedClosed)).toBe(true);
    }
  });

  it("every decision is a valid Decision with one-sentence summary and reason", async () => {
    const { results } = await run({ worldSeed: "genesis", objective: "maximize_net_worth" });
    for (const r of results) {
      expect(decisionSchema.safeParse(r.decision).success).toBe(true);
      expect(r.decision.summary.length).toBeLessThanOrEqual(280);
      expect(r.decision.reason.length).toBeLessThanOrEqual(400);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("different objectives yield different action mixes", async () => {
    const mixes = new Map<Objective, Record<string, number>>();
    for (const objective of OBJECTIVES) {
      const { results } = await run({ worldSeed: "genesis", objective });
      mixes.set(objective, actionMix(results));
    }
    const signatures = new Set([...mixes.values()].map((m) => JSON.stringify(m)));
    expect(signatures.size).toBeGreaterThanOrEqual(4);

    const survive = mixes.get("survive") ?? {};
    expect(survive.BUY_SERVICE ?? 0).toBe(0);
    expect(survive.TRANSFER ?? 0).toBe(0);
    expect(survive.POST_JOB ?? 0).toBe(0);

    expect(mixes.get("maximize_information")?.BUY_SERVICE ?? 0).toBeGreaterThan(0);
    expect(mixes.get("maximize_reputation")?.SELL_SERVICE ?? 0).toBeGreaterThan(0);
    const coalition = mixes.get("build_coalition") ?? {};
    expect((coalition.POST_JOB ?? 0) + (coalition.TRANSFER ?? 0)).toBeGreaterThan(0);
    expect(mixes.get("profitable_service")?.SELL_SERVICE ?? 0).toBeGreaterThan(0);
    expect(mixes.get("information_broker")?.BUY_SERVICE ?? 0).toBeGreaterThan(0);
  });

  it("never spends above the budget cap and only references ids present in the observation", async () => {
    const budgets: Observation["budget"][] = [
      {
        maxSpendPerActionDrops: "20000",
        remainingHourDrops: "50000",
        remainingDayDrops: "80000",
        minimumBalanceDrops: "1500000",
        allowedServiceCategories: ["intelligence", "analysis", "logistics"],
      },
      {
        maxSpendPerActionDrops: "500000",
        remainingHourDrops: "3000",
        remainingDayDrops: "8000000",
        minimumBalanceDrops: "1500000",
        allowedServiceCategories: ["intelligence"],
      },
      {
        maxSpendPerActionDrops: "500000",
        remainingHourDrops: "3000000",
        remainingDayDrops: "8000000",
        minimumBalanceDrops: "19500000",
        allowedServiceCategories: [],
      },
    ];
    for (const objective of OBJECTIVES) {
      for (const [i, budget] of budgets.entries()) {
        const { results, observations } = await run({
          worldSeed: `budget-${i}`,
          objective,
          seed: `budget-${i}`,
          fixture: { balanceDrops: 2_000_000n + BigInt(i) * 9_000_000n, overrides: { budget } },
        });
        results.forEach((r, tick) => {
          const obs = observations[tick];
          if (!obs) throw new Error("missing observation");
          const cap = spendCapDrops(obs);
          expect(spendOf(r.decision.action)).toBeLessThanOrEqual(cap);
          const ids = knownIds(obs);
          for (const id of referencedIds(r.decision.action)) expect(ids.has(id)).toBe(true);
          if (r.decision.action.type === "BUY_SERVICE") {
            const service = obs.availableServices.find(
              (s) => s.id === (r.decision.action as { serviceId: string }).serviceId,
            );
            expect(service).toBeDefined();
            expect(service?.sellerAgentId).not.toBe(obs.agentId);
            expect(budget.allowedServiceCategories.length).toBeGreaterThan(0);
          }
        });
      }
    }
  });

  it("submits claimed jobs it can fulfil and accepts open jobs", async () => {
    const brain = new DeterministicAgent({ worldSeed: "jobs" });
    const base = syntheticObservation({
      seed: "jobs",
      objective: "maximize_reputation",
      knowledge: 2,
    });
    const claimed = {
      ...base.availableJobs[0]!,
      status: "claimed",
      claimedByAgentId: base.agentId,
    };
    const obs = syntheticObservation({
      seed: "jobs",
      objective: "maximize_reputation",
      knowledge: 2,
      overrides: { myJobs: [claimed], availableJobs: base.availableJobs.slice(1) },
    });
    const result = await brain.decide(obs);
    expect(result.decision.action.type).toBe("SUBMIT_JOB");
    expect((result.decision.action as { jobId: string }).jobId).toBe(claimed.id);
  });

  it("waits when the agent is not active", async () => {
    const brain = new DeterministicAgent({ worldSeed: "paused" });
    const obs = syntheticObservation({
      objective: "maximize_information",
      overrides: { status: "paused" },
    });
    const result = await brain.decide(obs);
    expect(result.decision.action).toEqual({ type: "WAIT" });
    expect(result.failedClosed).toBe(false);
  });

  it("uses seeded randomness only for tie-breaks (same seed ⇒ same pick among equal candidates)", async () => {
    const obs = syntheticObservation({ objective: "maximize_information", services: 6 });
    const equal = obs.availableServices.map((s, i) => ({
      ...s,
      kind: "SCOUT" as const,
      priceDrops: "2000",
      successRate: 1,
      reputation: 80,
      score: 1 - i * 0.01,
    }));
    const tied = { ...obs, availableServices: equal };
    const a = await new DeterministicAgent({ worldSeed: "one" }).decide(tied);
    const b = await new DeterministicAgent({ worldSeed: "one" }).decide(tied);
    expect(a.decision).toEqual(b.decision);
    expect(a.decision.action.type).toBe("BUY_SERVICE");
    const picks = new Set<string>();
    for (const seed of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
      const r = await new DeterministicAgent({ worldSeed: seed }).decide(tied);
      picks.add(JSON.stringify(r.decision.action));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it("reflectOnOutcome returns deterministic JSON-serialisable memory", async () => {
    const brain = new DeterministicAgent({ worldSeed: "m" });
    const obs = syntheticObservation({ objective: "maximize_information" });
    const decision: Decision = {
      action: {
        type: "BUY_SERVICE",
        serviceId: obs.availableServices[0]!.id,
        input: {},
        maxPriceDrops: "1000",
      },
      summary: "Buying.",
      reason: "Test.",
    };
    const m1 = await brain.reflectOnOutcome(obs, decision, {
      status: "success",
      outcome: "ok",
      costDrops: 1000n,
    });
    const m2 = await brain.reflectOnOutcome(obs, decision, {
      status: "success",
      outcome: "ok",
      costDrops: 1000n,
    });
    expect(m1).toEqual(m2);
    expect(JSON.parse(JSON.stringify(m1))).toEqual(m1);
    expect(m1.ticksSinceLastPurchase).toBe(0);
    expect(m1.purchasedServiceIds).toEqual([obs.availableServices[0]!.id]);
    expect(m1.lastAction).toMatchObject({
      type: "BUY_SERVICE",
      status: "success",
      costDrops: "1000",
    });
    const m3 = await brain.reflectOnOutcome({ ...obs, memory: m1 }, decision, {
      status: "failed",
      outcome: "boom",
    });
    expect(m3.consecutiveFailures).toBe(1);
    expect(m3.failedServiceIds).toEqual([obs.availableServices[0]!.id]);
  });
});
