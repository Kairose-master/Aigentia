import type { Decision, Observation } from "@aigentia/protocol";
import { BrainFailure, parseDecisionText, parseRawDecision, runDecide } from "../brain";
import type { AgentBrain, DecisionResult, ExecutionOutcome, ObservationView, Plan } from "../brain";
import { memoryToRecord, updateMemory } from "../memory";
import { compactObservation } from "../observation-summary";

const planDecision = new WeakMap<Plan, Decision>();

/**
 * Replays raw (possibly invalid) outputs through the same validation path as
 * LLMAgentBrain, so engine tests can exercise fail-closed behaviour without a model.
 * Strings are parsed as JSON text; objects go straight to the decision validator.
 * Entries are consumed in order; the last entry repeats once exhausted.
 */
export class ScriptedBrain implements AgentBrain {
  readonly kind = "llm" as const;
  readonly model = "scripted";
  private index = 0;
  readonly calls: unknown[] = [];

  constructor(private readonly decisions: readonly unknown[]) {}

  async observe(obs: Observation): Promise<ObservationView> {
    return compactObservation(obs);
  }

  async plan(_view: ObservationView): Promise<Plan> {
    if (this.decisions.length === 0) throw new BrainFailure("script exhausted: no decisions");
    const raw = this.decisions[Math.min(this.index, this.decisions.length - 1)];
    this.index += 1;
    this.calls.push(raw);
    if (raw instanceof Error) throw raw;
    const decision = typeof raw === "string" ? parseDecisionText(raw) : parseRawDecision(raw);
    const plan: Plan = {
      candidates: [
        { action: decision.action, expectedValueDrops: 0n, risk: 0.5, note: decision.summary },
      ],
      notes: ["scripted"],
    };
    planDecision.set(plan, decision);
    return plan;
  }

  async chooseAction(plan: Plan): Promise<Decision> {
    const decision = planDecision.get(plan);
    if (!decision) throw new BrainFailure("plan was not produced by this brain");
    return decision;
  }

  async summarizeReason(decision: Decision, _plan: Plan): Promise<string> {
    return decision.reason;
  }

  async reflectOnOutcome(
    obs: Observation,
    decision: Decision,
    outcome: ExecutionOutcome,
  ): Promise<Record<string, unknown>> {
    return memoryToRecord(updateMemory(obs, decision, outcome));
  }

  decide(obs: Observation): Promise<DecisionResult> {
    return runDecide(this, obs);
  }
}
