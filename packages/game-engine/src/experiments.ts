import { computeNetWorthDrops } from "@aigentia/economy";
import {
  experimentConfigSchema,
  experimentResultsSchema,
  type ExperimentConfig,
  type ExperimentConfigInput,
  type ExperimentResults,
} from "@aigentia/protocol";
import { AigentiaError, type Objective } from "@aigentia/shared";
import type { CreateAgentInput } from "./agent-factory";
import type { BalanceSource, Clock } from "./context";
import type { EventLog } from "./events";
import type { IdGenerator } from "./ids";
import type { AgentRecord, ExperimentRecord, PaymentRecord, WorldStore } from "./store/types";
import { fmtXrp } from "./world";

/** The flagship experiment from the product brief. */
export const GENESIS_24H: ExperimentConfigInput = {
  name: "Genesis 24H",
  durationHours: 24,
  agentCount: 20,
  startingCapitalXrp: 10,
  humanInterventionAfterStart: false,
  objectiveDistribution: [
    { objective: "maximize_net_worth", count: 5 },
    { objective: "survive", count: 5 },
    { objective: "maximize_information", count: 5 },
    { objective: "maximize_reputation", count: 5 },
  ],
  brain: "deterministic",
  seed: "genesis-24h",
};

const CALLSIGNS = [
  "ORION",
  "ATLAS",
  "NOVA",
  "ECHO",
  "VEGA",
  "LYRA",
  "RIGEL",
  "ALTAIR",
  "CYGNUS",
  "DRACO",
  "HYDRA",
  "SIRIUS",
  "CASTOR",
  "POLLUX",
  "ANTARES",
  "DENEB",
  "MIRA",
  "SPICA",
  "TALOS",
  "KEPLER",
] as const;

export interface ExperimentDeps {
  readonly store: WorldStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly events: EventLog;
  readonly balances: BalanceSource;
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
}

/** Validate and store a draft experiment. Objective counts must add up to agentCount. */
export async function createExperiment(
  deps: Pick<ExperimentDeps, "store" | "ids" | "clock">,
  input: ExperimentConfigInput,
): Promise<ExperimentRecord> {
  const config = experimentConfigSchema.parse(input);
  const total = config.objectiveDistribution.reduce((sum, o) => sum + o.count, 0);
  if (total !== config.agentCount) {
    throw new AigentiaError(
      "VALIDATION_FAILED",
      `objective distribution assigns ${total} agents, expected ${config.agentCount}`,
    );
  }
  return deps.store.insertExperiment({
    id: deps.ids.next("experiment", `experiment:${config.seed}:${config.name}`),
    name: config.name,
    config,
    seed: config.seed,
    createdAt: deps.clock(),
  });
}

/** Deterministic, unique call signs: ORION-1-K3 (call sign, ordinal, experiment tag). */
export function experimentAgentNames(experimentId: string, count: number): string[] {
  const tag = experimentId.slice(-2).toUpperCase();
  return Array.from(
    { length: count },
    (_, i) => `${CALLSIGNS[i % CALLSIGNS.length]}-${i + 1}-${tag}`,
  );
}

/** Objectives in creation order, interleaved so every objective is represented early. */
export function objectiveSchedule(config: ExperimentConfig): Objective[] {
  const pools = config.objectiveDistribution.map((o) => ({
    objective: o.objective,
    left: o.count,
  }));
  const out: Objective[] = [];
  while (out.length < config.agentCount) {
    for (const pool of pools) {
      if (pool.left > 0 && out.length < config.agentCount) {
        out.push(pool.objective);
        pool.left -= 1;
      }
    }
  }
  return out;
}

/**
 * Create and fund the agents, then hand the world to the agents: the simulation starts and,
 * with humanInterventionAfterStart=false, admin changes are refused until the end.
 */
export async function startExperiment(deps: ExperimentDeps, id: string): Promise<ExperimentRecord> {
  const { store, clock, events } = deps;
  const experiment = await store.getExperiment(id);
  if (!experiment) throw new AigentiaError("NOT_FOUND", `experiment ${id} not found`);
  if (experiment.status !== "draft") {
    throw new AigentiaError("CONFLICT", `experiment ${id} is ${experiment.status}`);
  }
  const running = await store.listExperiments({ status: "running" });
  if (running.length > 0) {
    throw new AigentiaError("CONFLICT", `experiment ${running[0]?.name ?? ""} is already running`);
  }
  const config = experimentConfigSchema.parse(experiment.config);
  const names = experimentAgentNames(id, config.agentCount);
  const objectives = objectiveSchedule(config);
  for (let i = 0; i < config.agentCount; i++) {
    const name = names[i];
    const objective = objectives[i];
    if (!name || !objective) continue;
    if (await store.getAgentByName(name)) continue; // idempotent restart after a partial start
    await deps.createAgent({
      name,
      objective,
      brain: config.brain,
      startingCapitalXrp: config.startingCapitalXrp,
      services: [],
      experimentId: id,
      ...(config.budgetPolicy ? { budgetPolicy: config.budgetPolicy } : {}),
    });
  }
  const now = clock();
  const state = await store.getSimulationState();
  const started = await store.updateExperiment(id, {
    status: "running",
    startedAt: now,
    endsAt: new Date(now.getTime() + config.durationHours * 3_600_000),
    startTick: state.currentTick,
  });
  await store.setSimulationState({ running: true });
  await events.emitOne({
    tick: state.currentTick,
    at: now,
    type: "EXPERIMENT_STARTED",
    experimentId: id,
    message: `Experiment "${experiment.name}" started: ${config.agentCount} agents, ${config.startingCapitalXrp} XRP each, ${config.durationHours}h, human intervention disabled`,
    payload: { experimentId: id },
  });
  return started;
}

/** Finish an experiment: freeze results computed from recorded state and verified payments. */
export async function finishExperiment(
  deps: Omit<ExperimentDeps, "createAgent">,
  id: string,
  opts: { readonly status?: "finished" | "aborted" } = {},
): Promise<ExperimentRecord> {
  const { store, clock, events } = deps;
  const experiment = await store.getExperiment(id);
  if (!experiment) throw new AigentiaError("NOT_FOUND", `experiment ${id} not found`);
  if (experiment.status !== "running") {
    throw new AigentiaError("CONFLICT", `experiment ${id} is ${experiment.status}`);
  }
  const now = clock();
  const state = await store.getSimulationState();
  const results = await computeExperimentResults(deps, experiment, state.currentTick);
  const finished = await store.updateExperiment(id, {
    status: opts.status ?? "finished",
    finishedAt: now,
    endTick: state.currentTick,
    results,
  });
  await events.emitOne({
    tick: state.currentTick,
    at: now,
    type: "EXPERIMENT_FINISHED",
    experimentId: id,
    message: `Experiment "${experiment.name}" finished after ${results.ticks} ticks: ${results.survival.alive} agents alive, ${results.verifiedPayments} verified payments, ${fmtXrp(BigInt(results.totalVolumeDrops))} volume`,
    payload: { experimentId: id },
  });
  return finished;
}

/** Called by the worker after each tick: finish every running experiment past its deadline. */
export async function finishDueExperiments(
  deps: Omit<ExperimentDeps, "createAgent">,
): Promise<ExperimentRecord[]> {
  const now = deps.clock().getTime();
  const out: ExperimentRecord[] = [];
  for (const e of await deps.store.listExperiments({ status: "running" })) {
    if (e.endsAt && e.endsAt.getTime() <= now) out.push(await finishExperiment(deps, e.id));
  }
  return out;
}

/** Gini coefficient of non-negative values (0 = equal, 1 = one holder owns everything). */
export function gini(values: readonly bigint[]): number {
  const xs = values
    .map((v) => Number(v))
    .filter((v) => v >= 0)
    .sort((a, b) => a - b);
  const n = xs.length;
  const total = xs.reduce((a, b) => a + b, 0);
  if (n === 0 || total === 0) return 0;
  let weighted = 0;
  xs.forEach((x, i) => (weighted += (i + 1) * x));
  return Math.min(1, Math.max(0, (2 * weighted) / (n * total) - (n + 1) / n));
}

/** Share of total held by the richest 10% (at least one holder). */
export function topShare(values: readonly bigint[], fraction = 0.1): number {
  const xs = [...values].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const total = xs.reduce((a, b) => a + b, 0n);
  if (xs.length === 0 || total === 0n) return 0;
  const k = Math.max(1, Math.ceil(xs.length * fraction));
  const top = xs.slice(0, k).reduce((a, b) => a + b, 0n);
  return Number((top * 1_000_000n) / total) / 1_000_000;
}

function leaderboard(rows: { agentId: string; name: string; value: bigint }[]) {
  return [...rows]
    .sort((a, b) =>
      a.value > b.value ? -1 : a.value < b.value ? 1 : a.agentId.localeCompare(b.agentId),
    )
    .map((r, i) => ({
      agentId: r.agentId,
      name: r.name,
      valueDrops: r.value.toString(),
      rank: i + 1,
    }));
}

/**
 * Every figure comes from recorded game state; anything that claims money moved counts only
 * payments with status "validated" AND a ledger transaction hash. Treasury funding is
 * excluded from revenue, volume and the network graph (it is not economic activity).
 */
export async function computeExperimentResults(
  deps: Pick<ExperimentDeps, "store" | "clock" | "balances">,
  experiment: ExperimentRecord,
  currentTick: number,
): Promise<ExperimentResults> {
  const { store } = deps;
  const agents = await store.listAgents({ experimentId: experiment.id });
  const ids = new Set(agents.map((a) => a.id));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const prices = Object.fromEntries(
    (await store.getMarketPrices()).map((m) => [m.resourceType, { bidDrops: m.bidDrops }]),
  );

  const netWorth = new Map<string, bigint>();
  for (const a of agents) {
    let balance = a.balanceDrops;
    try {
      balance = (await deps.balances.getBalanceDrops(a.walletAddress)).balanceDrops;
    } catch {
      // ledger unreachable: fall back to the last cached (ledger-derived) balance
    }
    const inventory = await store.getInventory(a.id);
    netWorth.set(
      a.id,
      computeNetWorthDrops({ balanceDrops: balance, inventory, marketPrices: prices }),
    );
  }

  const payments: PaymentRecord[] = await store.listPaymentsForAgents([...ids]);
  const verified = payments.filter((p) => p.status === "validated" && p.txHash !== null);
  const economic = verified.filter((p) => p.kind !== "funding");

  const revenue = new Map<string, bigint>();
  const edges = new Map<string, { from: string; to: string; count: number; volume: bigint }>();
  let volume = 0n;
  for (const p of economic) {
    volume += p.amountDrops;
    if (p.receiverAgentId && ids.has(p.receiverAgentId)) {
      revenue.set(p.receiverAgentId, (revenue.get(p.receiverAgentId) ?? 0n) + p.amountDrops);
    }
    if (
      p.senderAgentId &&
      p.receiverAgentId &&
      ids.has(p.senderAgentId) &&
      ids.has(p.receiverAgentId)
    ) {
      const key = `${p.senderAgentId}>${p.receiverAgentId}`;
      const edge = edges.get(key) ?? {
        from: p.senderAgentId,
        to: p.receiverAgentId,
        count: 0,
        volume: 0n,
      };
      edge.count += 1;
      edge.volume += p.amountDrops;
      edges.set(key, edge);
    }
  }

  const services = (await store.listServices()).filter((s) => ids.has(s.sellerAgentId));
  const serviceUsage = services
    .map((s) => ({
      serviceId: s.id,
      kind: s.kind,
      sellerAgentId: s.sellerAgentId,
      calls: s.successfulCalls + s.failedCalls,
      revenueDrops: s.totalRevenueDrops.toString(),
      failures: s.failedCalls,
    }))
    .sort((a, b) => b.calls - a.calls || a.serviceId.localeCompare(b.serviceId));

  const trades = (await store.listTrades()).filter(
    (t) =>
      (t.buyerAgentId && ids.has(t.buyerAgentId)) || (t.sellerAgentId && ids.has(t.sellerAgentId)),
  );
  const alive = agents.filter((a) => a.status !== "bankrupt");
  const worths = agents.map((a) => netWorth.get(a.id) ?? 0n);

  return experimentResultsSchema.parse({
    computedAt: deps.clock().toISOString(),
    ticks: Math.max(0, currentTick - (experiment.startTick ?? currentTick)),
    wealthLeaderboard: leaderboard(
      agents.map((a) => ({ agentId: a.id, name: a.name, value: netWorth.get(a.id) ?? 0n })),
    ),
    revenueLeaderboard: leaderboard(
      agents.map((a) => ({ agentId: a.id, name: a.name, value: revenue.get(a.id) ?? 0n })),
    ),
    serviceUsage,
    mostUsedServices: serviceUsage
      .filter((s) => s.calls > 0)
      .slice(0, 5)
      .map((s) => ({
        serviceId: s.serviceId,
        kind: s.kind,
        sellerName: byId.get(s.sellerAgentId)?.name ?? s.sellerAgentId,
        calls: s.calls,
      })),
    tradeCount: trades.length,
    survival: {
      alive: alive.length,
      bankrupt: agents.length - alive.length,
      survivors: alive.map((a) => a.name),
    },
    economicConcentration: { gini: gini(worths), top10PercentShare: topShare(worths) },
    failedPayments: payments.filter((p) => p.status === "failed").length,
    verifiedPayments: verified.length,
    totalVolumeDrops: volume.toString(),
    networkGraph: {
      nodes: agents.map((a) => ({
        id: a.id,
        name: a.name,
        objective: a.objective,
        netWorthDrops: (netWorth.get(a.id) ?? 0n).toString(),
        status: a.status,
      })),
      edges: [...edges.values()]
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
        .map((e) => ({ from: e.from, to: e.to, count: e.count, volumeDrops: e.volume.toString() })),
    },
  });
}
