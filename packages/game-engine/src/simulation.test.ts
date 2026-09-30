import { describe, expect, it } from "vitest";
import type { AgentBrain } from "@aigentia/agent-core";
import { ScriptedBrain } from "@aigentia/agent-core/testing";
import type { PaymentAdapter } from "@aigentia/economy";
import type { AgentActionInput } from "@aigentia/protocol";
import { AigentiaError, XRP } from "@aigentia/shared";
import { buildTestWorld, type TestAgentSpec, type TestWorld } from "./testing";

const SIX_AGENTS: TestAgentSpec[] = [
  { name: "ORION-7", objective: "maximize_net_worth", capitalXrp: 20 },
  {
    name: "ATLAS-3",
    objective: "survive",
    capitalXrp: 20,
    services: [{ kind: "SCOUT", priceDrops: "5000" }],
  },
  { name: "NOVA-2", objective: "build_coalition", capitalXrp: 20 },
  { name: "ECHO-9", objective: "maximize_information", capitalXrp: 20 },
  {
    name: "VEGA-1",
    objective: "maximize_reputation",
    capitalXrp: 20,
    services: [{ kind: "ANALYST", priceDrops: "8000" }],
  },
  { name: "LYRA-5", objective: "information_broker", capitalXrp: 20 },
];

function decide(action: AgentActionInput, summary = "Scripted action."): unknown {
  return { action, summary, reason: "Scripted for the test." };
}

/** Brains keyed by agent name; missing names fall back to the deterministic brain. */
function brainMap(
  brains: Record<string, AgentBrain>,
): (agent: { name: string }) => AgentBrain | undefined {
  return (agent) => brains[agent.name];
}

async function balanceOf(world: TestWorld, name: string): Promise<bigint> {
  return (await world.ledger.getBalanceDrops(world.agent(name).walletAddress)).balanceDrops;
}

async function reputationOf(world: TestWorld, name: string): Promise<number> {
  const agent = await world.store.getAgent(world.agent(name).id);
  return agent?.reputation ?? Number.NaN;
}

describe("Simulation", () => {
  it("is deterministic: same seed → identical state hash and event feed after 25 ticks", async () => {
    const a = await buildTestWorld({ seed: "determinism", agents: SIX_AGENTS });
    const b = await buildTestWorld({ seed: "determinism", agents: SIX_AGENTS });
    await a.runTicks(25);
    await b.runTicks(25);
    const messagesA = a.store.allEvents().map((e) => `${e.tick}:${e.type}:${e.message}`);
    const messagesB = b.store.allEvents().map((e) => `${e.tick}:${e.type}:${e.message}`);
    expect(messagesA).toEqual(messagesB);
    expect(a.store.stateHash()).toBe(b.store.stateHash());
    expect(a.ledger.snapshot()).toEqual(b.ledger.snapshot());
    // The economy actually moved: verified payments between agents exist.
    const purchases = a.store.allEvents().filter((e) => e.type === "SERVICE_PURCHASED");
    expect(purchases.length).toBeGreaterThan(0);
    expect(purchases.every((e) => typeof e.txHash === "string" && e.txHash.length === 64)).toBe(
      true,
    );
    const c = await buildTestWorld({ seed: "other-seed", agents: SIX_AGENTS });
    await c.runTicks(25);
    expect(c.store.stateHash()).not.toBe(a.store.stateHash());
  }, 60_000);

  it("blocks overspend: BUY_SERVICE above maxSpendPerAction is denied and the service never runs", async () => {
    const brains: Record<string, AgentBrain> = {};
    const world = await buildTestWorld({
      seed: "overspend",
      agents: [
        { name: "BUYER-1", objective: "maximize_information", capitalXrp: 20 },
        {
          name: "SELLER-1",
          objective: "survive",
          capitalXrp: 10,
          services: [{ kind: "SCOUT", priceDrops: "600000" }],
        },
      ],
      brainFor: brainMap(brains),
    });
    const service = (await world.store.listServices({ kind: "SCOUT" }))[0];
    expect(service).toBeDefined();
    brains["BUYER-1"] = new ScriptedBrain([
      decide({
        type: "BUY_SERVICE",
        serviceId: service?.id ?? "",
        input: {},
        maxPriceDrops: "700000",
      }),
    ]);
    brains["SELLER-1"] = new ScriptedBrain([decide({ type: "WAIT" })]);
    const before = await balanceOf(world, "BUYER-1");
    const [tick] = await world.runTicks(1);
    const trace = tick?.decisions.find((d) => d.agentName === "BUYER-1");
    expect(trace?.outcomeStatus).toBe("rejected");
    expect(trace?.outcome).toContain("MAX_SPEND_PER_ACTION");
    const events = world.store.allEvents();
    const denied = events.find((e) => e.type === "PAYMENT_DENIED");
    expect(denied).toBeDefined();
    expect(denied?.message).toContain("MAX_SPEND_PER_ACTION");
    expect(
      events.some((e) => e.type === "SERVICE_FULFILLED" || e.type === "SERVICE_PURCHASED"),
    ).toBe(false);
    expect(await balanceOf(world, "BUYER-1")).toBe(before);
    expect((await world.store.getService(service?.id ?? ""))?.successfulCalls).toBe(0);
    const payment = (await world.store.listPaymentsForAgent(world.agent("BUYER-1").id))[0];
    expect(payment?.status).toBe("denied");
    expect(payment?.txHash).toBeNull();
    const invocation = await world.store.getInvocationByInvoice(payment?.invoiceId ?? "");
    expect(invocation?.status).toBe("rejected");
    expect(invocation?.response).toBeNull();
    expect(await reputationOf(world, "BUYER-1")).toBe(49.5);
  });

  it("blocks a TRANSFER that would dip below the minimum balance", async () => {
    const brains: Record<string, AgentBrain> = {};
    const policy = {
      maxSpendPerActionDrops: "10000000",
      maxSpendPerHourDrops: "50000000",
      maxDailySpendDrops: "50000000",
    };
    const world = await buildTestWorld({
      seed: "reserve",
      agents: [
        { name: "TIPPER-1", objective: "build_coalition", capitalXrp: 10, budgetPolicy: policy },
        { name: "FRIEND-1", objective: "survive", capitalXrp: 10 },
      ],
      brainFor: brainMap(brains),
    });
    brains["TIPPER-1"] = new ScriptedBrain([
      decide({ type: "TRANSFER", toAgentId: world.agent("FRIEND-1").id, amountDrops: "8000000" }),
    ]);
    brains["FRIEND-1"] = new ScriptedBrain([decide({ type: "WAIT" })]);
    const before = await balanceOf(world, "TIPPER-1");
    const [tick] = await world.runTicks(1);
    const trace = tick?.decisions.find((d) => d.agentName === "TIPPER-1");
    expect(trace?.outcomeStatus).toBe("rejected");
    expect(trace?.outcome).toContain("MINIMUM_BALANCE");
    expect(trace?.outcome).not.toContain("MAX_SPEND_PER_ACTION");
    expect(world.store.allEvents().some((e) => e.type === "PAYMENT_DENIED")).toBe(true);
    expect(world.store.allEvents().some((e) => e.type === "TRANSFER_SENT")).toBe(false);
    expect(await balanceOf(world, "TIPPER-1")).toBe(before);
  });

  it("fails closed on invalid brain output: WAIT, ACTION_INVALID, outcomeStatus invalid", async () => {
    const world = await buildTestWorld({
      seed: "invalid",
      agents: [{ name: "GLITCH-1", objective: "survive", capitalXrp: 10 }],
      brainFor: brainMap({
        "GLITCH-1": new ScriptedBrain(["this is not json", { action: { type: "LAUNCH_NUKES" } }]),
      }),
    });
    const [t1, t2] = await world.runTicks(2);
    for (const tick of [t1, t2]) {
      const trace = tick?.decisions[0];
      expect(trace?.action).toEqual({ type: "WAIT" });
      expect(trace?.failedClosed).toBe(true);
      expect(trace?.outcomeStatus).toBe("invalid");
    }
    expect(world.store.allEvents().filter((e) => e.type === "ACTION_INVALID").length).toBe(2);
    const decisions = await world.store.listDecisions(world.agent("GLITCH-1").id);
    expect(decisions.every((d) => d.outcomeStatus === "invalid")).toBe(true);
  });

  it("lets a job be claimed exactly once when two agents accept it in the same tick", async () => {
    const brains: Record<string, AgentBrain> = {};
    const world = await buildTestWorld({
      seed: "claim-race",
      agents: [
        { name: "POSTER-1", objective: "build_coalition", capitalXrp: 20 },
        { name: "WORKER-A", objective: "survive", capitalXrp: 10 },
        { name: "WORKER-B", objective: "survive", capitalXrp: 10 },
      ],
      brainFor: brainMap(brains),
    });
    brains["POSTER-1"] = new ScriptedBrain([
      decide({
        type: "POST_JOB",
        title: "Deliver ore",
        description: "Bring two ore to Core Station.",
        rewardDrops: "50000",
        requirement: { kind: "analysis" },
        expiresInTicks: 10,
      }),
      decide({ type: "WAIT" }),
    ]);
    brains["WORKER-A"] = new ScriptedBrain([decide({ type: "WAIT" })]);
    brains["WORKER-B"] = new ScriptedBrain([decide({ type: "WAIT" })]);
    await world.runTicks(1);
    const job = (await world.store.listOpenJobs())[0];
    expect(job?.title).toBe("Deliver ore");
    brains["WORKER-A"] = new ScriptedBrain([decide({ type: "ACCEPT_JOB", jobId: job?.id ?? "" })]);
    brains["WORKER-B"] = new ScriptedBrain([decide({ type: "ACCEPT_JOB", jobId: job?.id ?? "" })]);
    const [tick] = await world.runTicks(1);
    const outcomes = (tick?.decisions ?? [])
      .filter((d) => d.agentName.startsWith("WORKER"))
      .map((d) => d.outcomeStatus)
      .sort();
    expect(outcomes).toEqual(["rejected", "success"]);
    const claimed = await world.store.getJob(job?.id ?? "");
    expect(claimed?.status).toBe("claimed");
    expect(world.store.allEvents().filter((e) => e.type === "JOB_CLAIMED").length).toBe(1);
  });

  it("raises the seller's reputation on a fulfilled service and lowers it on a failed one", async () => {
    const brains: Record<string, AgentBrain> = {};
    const world = await buildTestWorld({
      seed: "reputation",
      agents: [
        {
          name: "SCOUT-S",
          objective: "survive",
          capitalXrp: 10,
          services: [{ kind: "SCOUT", priceDrops: "5000" }],
        },
        {
          name: "ANALYST-S",
          objective: "survive",
          capitalXrp: 10,
          services: [{ kind: "ANALYST", priceDrops: "5000" }],
        },
        { name: "BUYER-A", objective: "maximize_information", capitalXrp: 20 },
        { name: "BUYER-B", objective: "maximize_information", capitalXrp: 20 },
      ],
      brainFor: brainMap(brains),
      executeService: async (kind, input, ctx) => {
        if (kind === "ANALYST") throw new AigentiaError("INTERNAL", "analyst model crashed");
        const { executeService } = await import("./services");
        return executeService(kind, input, ctx);
      },
    });
    const scout = (await world.store.listServices({ kind: "SCOUT" }))[0];
    const analyst = (await world.store.listServices({ kind: "ANALYST" }))[0];
    brains["SCOUT-S"] = new ScriptedBrain([decide({ type: "WAIT" })]);
    brains["ANALYST-S"] = new ScriptedBrain([decide({ type: "WAIT" })]);
    brains["BUYER-A"] = new ScriptedBrain([
      decide({ type: "BUY_SERVICE", serviceId: scout?.id ?? "", input: {}, maxPriceDrops: "5000" }),
    ]);
    brains["BUYER-B"] = new ScriptedBrain([
      decide({
        type: "BUY_SERVICE",
        serviceId: analyst?.id ?? "",
        input: { horizonTicks: 5 },
        maxPriceDrops: "5000",
      }),
    ]);
    const [tick] = await world.runTicks(1);
    const a = tick?.decisions.find((d) => d.agentName === "BUYER-A");
    const b = tick?.decisions.find((d) => d.agentName === "BUYER-B");
    expect(a?.outcomeStatus).toBe("success");
    expect(b?.outcomeStatus).toBe("failed");
    expect(await reputationOf(world, "SCOUT-S")).toBe(51);
    expect(await reputationOf(world, "BUYER-A")).toBe(50.25);
    expect(await reputationOf(world, "ANALYST-S")).toBe(47);
    const analystRow = await world.store.getService(analyst?.id ?? "");
    expect(analystRow?.failedCalls).toBe(1);
    expect(analystRow?.successfulCalls).toBe(0);
    expect(world.store.allEvents().some((e) => e.type === "SERVICE_FAILED")).toBe(true);
    const knowledge = await world.store.getKnowledge(world.agent("BUYER-A").id);
    expect(knowledge.length).toBeGreaterThan(0);
  });

  it("grants no service when the payment fails: invocation failed, no output, buyer penalised", async () => {
    const brains: Record<string, AgentBrain> = {};
    const failing = (adapter: PaymentAdapter): PaymentAdapter => ({
      ledger: adapter.ledger,
      async execute(intent, ctx) {
        if (intent.purpose === "x402") {
          throw new AigentiaError(
            "PAYMENT_FAILED",
            "mock ledger rejected transaction: tecUNFUNDED_PAYMENT",
            {
              intentId: intent.id,
              ledger: adapter.ledger,
              result: "tecUNFUNDED_PAYMENT",
            },
          );
        }
        return adapter.execute(intent, ctx);
      },
    });
    const world = await buildTestWorld({
      seed: "payment-failure",
      agents: [
        {
          name: "SELLER-F",
          objective: "survive",
          capitalXrp: 10,
          services: [{ kind: "SCOUT", priceDrops: "5000" }],
        },
        { name: "BUYER-F", objective: "maximize_information", capitalXrp: 20 },
      ],
      brainFor: brainMap(brains),
      adapter: failing,
    });
    const scout = (await world.store.listServices({ kind: "SCOUT" }))[0];
    brains["SELLER-F"] = new ScriptedBrain([decide({ type: "WAIT" })]);
    brains["BUYER-F"] = new ScriptedBrain([
      decide({ type: "BUY_SERVICE", serviceId: scout?.id ?? "", input: {}, maxPriceDrops: "5000" }),
    ]);
    const [tick] = await world.runTicks(1);
    const trace = tick?.decisions.find((d) => d.agentName === "BUYER-F");
    expect(trace?.outcomeStatus).toBe("failed");
    expect(trace?.costDrops).toBeUndefined();
    const payment = (await world.store.listPaymentsForAgent(world.agent("BUYER-F").id))[0];
    expect(payment?.status).toBe("failed");
    expect(payment?.txHash).toBeNull();
    const invocation = await world.store.getInvocationByInvoice(payment?.invoiceId ?? "");
    expect(invocation?.status).toBe("failed");
    expect(invocation?.response).toBeNull();
    expect(await world.store.getKnowledge(world.agent("BUYER-F").id)).toEqual([]);
    const events = world.store.allEvents();
    expect(events.some((e) => e.type === "PAYMENT_FAILED")).toBe(true);
    expect(
      events.some((e) => e.type === "SERVICE_PURCHASED" || e.type === "SERVICE_FULFILLED"),
    ).toBe(false);
    expect(await reputationOf(world, "BUYER-F")).toBe(49);
    expect(await reputationOf(world, "SELLER-F")).toBe(50);
  });

  it("pays the job reward with a verifiable mock receipt on SUBMIT_JOB", async () => {
    const brains: Record<string, AgentBrain> = {};
    const world = await buildTestWorld({
      seed: "job-reward",
      agents: [
        { name: "POSTER-J", objective: "build_coalition", capitalXrp: 20 },
        { name: "WORKER-J", objective: "survive", capitalXrp: 10 },
      ],
      brainFor: brainMap(brains),
    });
    const deposit = (await world.store.listResources()).find((r) => r.resourceType === "ore");
    expect(deposit).toBeDefined();
    brains["POSTER-J"] = new ScriptedBrain([
      decide({
        type: "POST_JOB",
        title: "Scout ore deposits",
        description: "Report where ore can be found.",
        rewardDrops: "100000",
        requirement: { kind: "report_resource_location", resourceType: "ore" },
        expiresInTicks: 10,
      }),
      decide({ type: "WAIT" }),
    ]);
    brains["WORKER-J"] = new ScriptedBrain([decide({ type: "WAIT" })]);
    await world.runTicks(1);
    const job = (await world.store.listOpenJobs())[0];
    brains["WORKER-J"] = new ScriptedBrain([
      decide({ type: "ACCEPT_JOB", jobId: job?.id ?? "" }),
      decide({
        type: "SUBMIT_JOB",
        jobId: job?.id ?? "",
        submission: { resourceType: "ore", locationId: deposit?.locationId ?? "" },
      }),
      decide({ type: "WAIT" }),
    ]);
    const workerBefore = await balanceOf(world, "WORKER-J");
    const [, submitTick] = await world.runTicks(2);
    const trace = submitTick?.decisions.find((d) => d.agentName === "WORKER-J");
    expect(trace?.outcomeStatus).toBe("success");
    expect(trace?.txHash).toMatch(/^[0-9A-F]{64}$/);
    const done = await world.store.getJob(job?.id ?? "");
    expect(done?.status).toBe("completed");
    const payment = await world.store.getPayment(done?.paymentId ?? "");
    expect(payment?.status).toBe("validated");
    expect(payment?.kind).toBe("job_reward");
    expect(payment?.ledger).toBe("mock");
    const verified = await world.ledger.verify(payment?.txHash ?? "", {
      destination: world.agent("WORKER-J").walletAddress,
      amountDrops: 100_000n,
      asset: XRP,
      sender: world.agent("POSTER-J").walletAddress,
    });
    expect(verified.ledger).toBe("mock");
    expect(await balanceOf(world, "WORKER-J")).toBe(workerBefore + 100_000n);
    expect(await reputationOf(world, "WORKER-J")).toBe(52);
    expect(await reputationOf(world, "POSTER-J")).toBe(51);
    expect(world.store.allEvents().some((e) => e.type === "JOB_COMPLETED")).toBe(true);
  });
});
