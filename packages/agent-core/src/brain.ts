import { AigentiaError, errorMessage } from "@aigentia/shared";
import { decisionSchema } from "@aigentia/protocol";
import type { AgentAction, Decision, Observation } from "@aigentia/protocol";

/**
 * AgentBrain contract (docs/ARCHITECTURE.md § packages/agent-core).
 *
 * A brain turns an Observation into exactly one Zod-validated Decision. It never sees
 * seeds, never builds or signs transactions and never touches the database. Invalid
 * output of any kind fails closed to WAIT; `decide` never throws.
 */
export interface AgentBrain {
  readonly kind: "deterministic" | "llm";
  readonly model: string;
  /** Compress/annotate what matters in the observation. */
  observe(obs: Observation): Promise<ObservationView>;
  /** Candidate actions with expected value. */
  plan(view: ObservationView): Promise<Plan>;
  /** Exactly one validated Decision. */
  chooseAction(plan: Plan): Promise<Decision>;
  /** Concise, spectator-safe reason for the chosen decision. */
  summarizeReason(decision: Decision, plan: Plan): Promise<string>;
  /** New strategy memory (JSON-serialisable), persisted on the agent between ticks. */
  reflectOnOutcome(
    obs: Observation,
    decision: Decision,
    outcome: ExecutionOutcome,
  ): Promise<Record<string, unknown>>;
  /** observe → plan → chooseAction → summarizeReason; always Zod-validated, never throws. */
  decide(obs: Observation): Promise<DecisionResult>;
}

/** Size-bounded view of the observation (see `compactObservation`). */
export interface ObservationView extends Observation {
  /** One-line summary for decision traces, e.g. "Balance 9.42 XRP · 3 services · 1 open job". */
  summary: string;
  /** How many items were dropped from each list when compacting. */
  truncated: {
    availableServices: number;
    availableJobs: number;
    recentEvents: number;
    nearbyAgents: number;
    resourceListings: number;
    knowledge: number;
    myJobs: number;
  };
}

export interface Candidate {
  action: AgentAction;
  /** Expected net value of the action in drops (may be negative). */
  expectedValueDrops: bigint;
  /** 0 (safe) .. 1 (very likely to fail or lose money). */
  risk: number;
  /** Short templated sentence, e.g. "Buying SCOUT service from ATLAS-3." */
  note: string;
}

export interface Plan {
  /** Ordered best-first; `candidates[0]` is the preferred action. Never empty after planning. */
  candidates: Candidate[];
  notes: string[];
}

export interface ExecutionOutcome {
  status: "success" | "failed" | "rejected" | "invalid";
  outcome: string;
  costDrops?: bigint;
  txHash?: string;
}

export interface BrainContext {
  worldSeed: string;
  tick: number;
}

export interface DecisionResult {
  decision: Decision;
  /** true when the brain could not produce a valid decision and WAIT was substituted. */
  failedClosed: boolean;
  latencyMs: number;
  error?: string;
}

/** The fail-closed decision. Frozen so nobody can mutate the shared instance. */
export const WAIT_DECISION: Readonly<Decision> = Object.freeze({
  action: Object.freeze({ type: "WAIT" as const }),
  summary: "Holding position.",
  reason: "Holding position.",
});

export function waitDecision(reason = "Holding position."): Decision {
  return { action: { type: "WAIT" }, summary: "Holding position.", reason };
}

/**
 * Raised when a brain cannot produce a valid decision (model error, malformed JSON,
 * unknown action type, schema failure). `decide` converts it into a fail-closed result.
 */
export class BrainFailure extends AigentiaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_FAILED", message, details);
    this.name = "BrainFailure";
  }
}

/**
 * The single validation path for anything claiming to be a Decision. Used by
 * LLMAgentBrain (model output), ScriptedBrain (test replays) and `runDecide`.
 * Throws BrainFailure; never returns an unvalidated value.
 */
export function parseRawDecision(raw: unknown): Decision {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BrainFailure("decision is not a JSON object", { received: typeof raw });
  }
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    const actionType = (raw as { action?: { type?: unknown } }).action?.type;
    throw new BrainFailure(`decision failed schema validation: ${issues.join("; ")}`, {
      issues,
      actionType: typeof actionType === "string" ? actionType : undefined,
    });
  }
  return parsed.data;
}

/** Parse raw model text (which may be malformed) through the same validation path. */
export function parseDecisionText(text: string): Decision {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new BrainFailure(`decision is not valid JSON: ${errorMessage(e)}`);
  }
  return parseRawDecision(json);
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Shared `decide` pipeline: observe → plan → chooseAction → summarizeReason, then a final
 * Zod validation. Any throw anywhere collapses to the fail-closed WAIT decision.
 */
export async function runDecide(brain: AgentBrain, obs: Observation): Promise<DecisionResult> {
  const started = nowMs();
  try {
    const view = await brain.observe(obs);
    const plan = await brain.plan(view);
    const chosen = await brain.chooseAction(plan);
    const reason = await brain.summarizeReason(chosen, plan);
    const decision = parseRawDecision({ ...chosen, reason: reason.trim() || chosen.reason });
    return { decision, failedClosed: false, latencyMs: Math.round(nowMs() - started) };
  } catch (e) {
    const error = errorMessage(e);
    return {
      decision: waitDecision(`Fail-closed: ${truncate(error, 300)}`),
      failedClosed: true,
      latencyMs: Math.round(nowMs() - started),
      error,
    };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
