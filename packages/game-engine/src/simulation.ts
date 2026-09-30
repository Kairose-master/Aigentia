import { summarizeObservation, type AgentBrain, type ExecutionOutcome } from "@aigentia/agent-core";
import { computeNetWorthDrops, type ServiceRanker, type SpendTracker } from "@aigentia/economy";
import type { AgentAction, Decision, WorldEvent } from "@aigentia/protocol";
import { SeededRandom, deriveSeed, errorMessage, type Logger } from "@aigentia/shared";
import type { BalanceSource, Clock, TreasuryInfo } from "./context";
import { EventLog, type EventSink } from "./events";
import { executeAction, type ExecutionResult } from "./executor";
import type { IdGenerator } from "./ids";
import { stepMarket } from "./market";
import { observeAgent } from "./observation-builder";
import type { ServicePurchaser, Settlement } from "./settlement";
import type {
  AgentRecord,
  DecisionOutcomeStatus,
  MarketPriceRecord,
  WorldStore,
} from "./store/types";
import { validateAction } from "./validator";

export interface SimulationDeps {
  readonly store: WorldStore;
  readonly brainFor: (agent: AgentRecord) => AgentBrain;
  readonly settlement: Settlement;
  readonly purchaser: ServicePurchaser;
  readonly balances: BalanceSource;
  readonly spendTracker: SpendTracker;
  readonly ranker: ServiceRanker;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly worldSeed: string;
  readonly apiPublicUrl: string;
  readonly treasury: TreasuryInfo;
  /** Shared event log (the same instance Settlement writes through). */
  readonly events?: EventLog;
  /** Used only when no `events` log is given: called after each event is persisted (SSE). */
  readonly eventSink?: EventSink;
  readonly logger?: Logger;
}

/** One agent's decision in a tick, as recorded on the decision trace. */
export interface DecisionTrace {
  readonly agentId: string;
  readonly agentName: string;
  readonly decisionId: string;
  readonly action: AgentAction;
  readonly summary: string;
  readonly reason: string;
  readonly outcomeStatus: DecisionOutcomeStatus;
  readonly outcome: string;
  readonly costDrops?: bigint;
  readonly paymentId?: string;
  readonly txHash?: string;
  readonly latencyMs: number;
  /** The brain produced an invalid decision and WAIT was substituted. */
  readonly failedClosed: boolean;
}

export interface TickResult {
  readonly tick: number;
  readonly agentsProcessed: number;
  readonly decisions: DecisionTrace[];
  readonly events: WorldEvent[];
  readonly errors: { agentId: string | null; error: string }[];
  readonly bankrupt: string[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

interface TickContext {
  readonly tick: number;
  readonly now: Date;
  readonly prices: MarketPriceRecord[];
}

/**
 * The deterministic tick loop (docs/ARCHITECTURE.md § Tick loop):
 *   for each active agent in id order: OBSERVE → PLAN/SELECT → VALIDATE → EXECUTE → RECORD → LEARN
 *   then snapshots, market step, job expiry. Per-agent errors are caught and recorded;
 *   nothing an agent does can abort the tick.
 */
export class Simulation {
  readonly events: EventLog;

  constructor(private readonly deps: SimulationDeps) {
    this.events = deps.events ?? new EventLog(deps.store, deps.eventSink);
  }

  async currentTick(): Promise<number> {
    return (await this.deps.store.getSimulationState()).currentTick;
  }

  async runTick(): Promise<TickResult> {
    const { store, clock, worldSeed } = this.deps;
    const state = await store.getSimulationState();
    const tick = state.currentTick + 1;
    const startedAt = clock();
    const collected: WorldEvent[] = [];
    const unsubscribe = this.events.subscribe((e) => collected.push(e));
    const errors: TickResult["errors"] = [];
    const decisions: DecisionTrace[] = [];
    const bankrupt: string[] = [];
    let processed = 0;

    try {
      await store.beginTick({ tick, seed: worldSeed, startedAt });
      await this.events.emitOne({
        tick,
        at: startedAt,
        type: "TICK_STARTED",
        message: `Tick ${tick} started`,
      });

      const ctx: TickContext = { tick, now: startedAt, prices: await store.getMarketPrices() };
      const agents = await store.listActiveAgents();
      for (const agent of agents) {
        try {
          const trace = await this.processAgent(agent, ctx, errors);
          decisions.push(trace);
          if (await this.checkBankruptcy(agent, ctx)) bankrupt.push(agent.id);
        } catch (e) {
          const error = errorMessage(e);
          errors.push({ agentId: agent.id, error });
          this.deps.logger?.error({ agentId: agent.id, tick, error }, "agent tick failed");
          decisions.push(await this.recordFailure(agent, ctx, error));
        }
        processed += 1;
      }

      await this.snapshotAgents(agents, ctx);
      await stepMarket(store, tick, new SeededRandom(deriveSeed(worldSeed, "market", tick)));
      await store.expireJobs(tick);

      const finishedAt = clock();
      await store.setSimulationState({ currentTick: tick, lastTickAt: finishedAt });
      await store.finishTick({
        tick,
        finishedAt,
        agentsProcessed: processed,
        status: "finished",
        error: null,
      });
      await this.events.emitOne({
        tick,
        at: finishedAt,
        type: "TICK_FINISHED",
        message: `Tick ${tick} finished: ${processed} agents, ${decisions.filter((d) => d.outcomeStatus === "success").length} successful actions`,
        payload: { agentsProcessed: processed, errors: errors.length, bankrupt },
      });
      return {
        tick,
        agentsProcessed: processed,
        decisions,
        events: collected,
        errors,
        bankrupt,
        startedAt,
        finishedAt,
      };
    } catch (e) {
      const finishedAt = clock();
      await store.finishTick({
        tick,
        finishedAt,
        agentsProcessed: processed,
        status: "failed",
        error: errorMessage(e),
      });
      throw e;
    } finally {
      unsubscribe();
    }
  }

  /** Run `count` ticks back to back. */
  async runTicks(count: number): Promise<TickResult[]> {
    const out: TickResult[] = [];
    for (let i = 0; i < count; i++) out.push(await this.runTick());
    return out;
  }

  private async processAgent(
    agent: AgentRecord,
    ctx: TickContext,
    errors: TickResult["errors"],
  ): Promise<DecisionTrace> {
    const { store, ids, balances, spendTracker, ranker } = this.deps;
    const { tick, now } = ctx;
    const scope = `${tick}:${agent.id}`;

    // OBSERVE
    const view = await observeAgent(agent, store, { balances, spendTracker, ranker, tick, now });
    const current = view.agent;

    // PLAN + SELECT ACTION (the brain only ever sees the observation)
    const brain = this.deps.brainFor(current);
    const result = await brain.decide(view.observation);
    const decision: Decision = result.decision;
    const decisionId = ids.next("decision", scope);
    const observationSummary = summarizeObservation(view.observation);

    // VALIDATE + EXECUTE
    let exec: ExecutionResult;
    let outcomeStatus: Exclude<DecisionOutcomeStatus, "pending">;
    if (result.failedClosed) {
      outcomeStatus = "invalid";
      exec = {
        status: "rejected",
        outcome: `Invalid decision, holding position: ${result.error ?? "unknown"}`,
        events: [],
      };
      await this.events.emitOne({
        tick,
        at: now,
        type: "ACTION_INVALID",
        agentId: current.id,
        message: `${current.name} produced an invalid decision and waits`,
        payload: { decisionId, error: result.error ?? null },
      });
    } else {
      const check = await validateAction(current, decision.action, store, {
        tick,
        balance: view.balance,
      });
      if (!check.ok) {
        outcomeStatus = "rejected";
        exec = { status: "rejected", outcome: `Rejected: ${check.reason}`, events: [] };
        await this.events.emitOne({
          tick,
          at: now,
          type: "ACTION_REJECTED",
          agentId: current.id,
          message: `${current.name}'s ${decision.action.type} was rejected: ${check.reason}`,
          payload: { decisionId, action: decision.action.type, reason: check.reason },
        });
      } else {
        if (decision.action.type !== "WAIT") {
          await this.events.emitOne({
            tick,
            at: now,
            type: "DECISION_MADE",
            agentId: current.id,
            message: `${current.name}: ${decision.summary}`,
            payload: { decisionId, action: decision.action.type, reason: decision.reason },
          });
        }
        exec = await executeAction(decision.action, {
          agent: current,
          tick,
          now,
          decisionId,
          scope,
          store,
          settlement: this.deps.settlement,
          purchaser: this.deps.purchaser,
          events: this.events,
          ids,
          balance: view.balance,
          apiPublicUrl: this.deps.apiPublicUrl,
          treasury: this.deps.treasury,
        });
        outcomeStatus = exec.status;
      }
    }

    // RECORD OUTCOME
    await store.recordDecision({
      id: decisionId,
      agentId: current.id,
      tick,
      observationSummary,
      action: decision.action as unknown as Record<string, unknown>,
      summary: decision.summary,
      reason: decision.reason,
      rationale: decision.rationale ? { ...decision.rationale } : null,
      costDrops: exec.costDrops ?? null,
      paymentId: exec.paymentId ?? null,
      txHash: exec.txHash ?? null,
      outcome: exec.outcome,
      outcomeStatus,
      brain: brain.model,
      latencyMs: result.latencyMs,
      createdAt: now,
    });
    await this.events.emit(exec.events);

    // LEARN (never fatal)
    const outcome: ExecutionOutcome = {
      status: outcomeStatus,
      outcome: exec.outcome,
      ...(exec.costDrops !== undefined ? { costDrops: exec.costDrops } : {}),
      ...(exec.txHash !== undefined ? { txHash: exec.txHash } : {}),
    };
    try {
      const memory = await brain.reflectOnOutcome(view.observation, decision, outcome);
      const fresh = (await store.getAgent(current.id)) ?? current;
      await store.updateAgent(current.id, {
        strategy: { ...fresh.strategy, memory },
        lastTick: tick,
      });
    } catch (e) {
      errors.push({ agentId: current.id, error: `reflect: ${errorMessage(e)}` });
    }

    return {
      agentId: current.id,
      agentName: current.name,
      decisionId,
      action: decision.action,
      summary: decision.summary,
      reason: decision.reason,
      outcomeStatus,
      outcome: exec.outcome,
      ...(exec.costDrops !== undefined ? { costDrops: exec.costDrops } : {}),
      ...(exec.paymentId !== undefined ? { paymentId: exec.paymentId } : {}),
      ...(exec.txHash !== undefined ? { txHash: exec.txHash } : {}),
      latencyMs: result.latencyMs,
      failedClosed: result.failedClosed,
    };
  }

  private async recordFailure(
    agent: AgentRecord,
    ctx: TickContext,
    error: string,
  ): Promise<DecisionTrace> {
    const decisionId = this.deps.ids.next("decision", `${ctx.tick}:${agent.id}:error`);
    const outcome = `Tick processing failed: ${error}`;
    await this.deps.store.recordDecision({
      id: decisionId,
      agentId: agent.id,
      tick: ctx.tick,
      observationSummary: "unavailable",
      action: { type: "WAIT" },
      summary: "Holding position.",
      reason: "The engine could not process this agent's turn.",
      outcome,
      outcomeStatus: "failed",
      brain: agent.brain,
      createdAt: ctx.now,
    });
    return {
      agentId: agent.id,
      agentName: agent.name,
      decisionId,
      action: { type: "WAIT" },
      summary: "Holding position.",
      reason: "The engine could not process this agent's turn.",
      outcomeStatus: "failed",
      outcome,
      latencyMs: 0,
      failedClosed: false,
    };
  }

  /** Bankrupt when the spendable balance is below the reserve and the inventory is worth nothing. */
  private async checkBankruptcy(agent: AgentRecord, ctx: TickContext): Promise<boolean> {
    const { store, balances } = this.deps;
    const [balance, inventory] = await Promise.all([
      balances.getBalanceDrops(agent.walletAddress),
      store.getInventory(agent.id),
    ]);
    const inventoryValue = computeNetWorthDrops({
      balanceDrops: 0n,
      inventory,
      marketPrices: Object.fromEntries(
        ctx.prices.map((p) => [p.resourceType, { bidDrops: p.bidDrops }]),
      ),
    });
    if (balance.spendableDrops >= balance.reserveDrops || inventoryValue > 0n) return false;
    await store.updateAgent(agent.id, {
      status: "bankrupt",
      balanceDrops: balance.balanceDrops,
      balanceCheckedAt: ctx.now,
    });
    await this.events.emit([
      {
        tick: ctx.tick,
        type: "AGENT_BANKRUPT",
        message: `${agent.name} went bankrupt`,
        agentId: agent.id,
        amountDrops: balance.balanceDrops.toString(),
        createdAt: ctx.now.toISOString(),
      },
      {
        tick: ctx.tick,
        type: "AGENT_STATUS_CHANGED",
        message: `${agent.name} is now bankrupt`,
        agentId: agent.id,
        payload: { from: "active", to: "bankrupt" },
        createdAt: ctx.now.toISOString(),
      },
    ]);
    return true;
  }

  private async snapshotAgents(agents: readonly AgentRecord[], ctx: TickContext): Promise<void> {
    const { store } = this.deps;
    const bids = Object.fromEntries(
      ctx.prices.map((p) => [p.resourceType, { bidDrops: p.bidDrops }]),
    );
    for (const agent of agents) {
      const fresh = await store.getAgent(agent.id);
      if (!fresh) continue;
      const inventory = await store.getInventory(agent.id);
      await store.snapshotAgent({
        agentId: fresh.id,
        tick: ctx.tick,
        balanceDrops: fresh.balanceDrops,
        netWorthDrops: computeNetWorthDrops({
          balanceDrops: fresh.balanceDrops,
          inventory,
          marketPrices: bids,
        }),
        reputation: fresh.reputation,
        createdAt: ctx.now,
      });
    }
  }
}
