import { Output, generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import {
  ACTION_TYPES,
  OBJECTIVES,
  RESOURCE_TYPES,
  SERVICE_KINDS,
  errorMessage,
} from "@aigentia/shared";
import { decisionSchema } from "@aigentia/protocol";
import type { Decision, Observation } from "@aigentia/protocol";
import { BrainFailure, parseRawDecision, runDecide } from "./brain";
import type {
  AgentBrain,
  Candidate,
  DecisionResult,
  ExecutionOutcome,
  ObservationView,
  Plan,
} from "./brain";
import { MEMORY_LIMITS, memoryToRecord, updateMemory } from "./memory";
import { compactObservation } from "./observation-summary";

export interface LLMAgentBrainOptions {
  /** Vercel AI SDK language model (provider-neutral). */
  model: LanguageModel;
  /** Recorded on decision traces, e.g. "anthropic/claude-fable-5-1". */
  modelId: string;
  worldSeed: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Retries of the model call on retryable provider errors (default 1). */
  maxRetries?: number;
  /** Per-call timeout in milliseconds (default 30_000). */
  timeoutMs?: number;
  /**
   * Make a second, short model call in reflectOnOutcome to record a one-line lesson.
   * Off by default (cost); the deterministic memory update always runs.
   */
  reflectWithModel?: boolean;
}

const DEFAULTS = {
  temperature: 0.2,
  maxOutputTokens: 600,
  maxRetries: 1,
  timeoutMs: 30_000,
} as const;

/** Spectator-safe: explains the economy and the exact contract. Never mentions seeds or signing. */
export function buildSystemPrompt(): string {
  return [
    "You are an autonomous economic agent in Aigentia, a simulated economy settled on the XRP Ledger.",
    "Agents earn and spend XRP by selling services to each other over x402 micropayments, trading resources with a world market, and completing posted jobs. Each tick you observe the world and choose exactly ONE action.",
    "",
    `Objectives (yours is given in the observation): ${OBJECTIVES.join(", ")}.`,
    "- maximize_net_worth: grow balance plus inventory value; buy intel only when it pays.",
    "- survive: spend almost nothing; earn small amounts; WAIT is fine.",
    "- maximize_information: buy SCOUT intel within budget, preferring cheap reputable sellers.",
    "- maximize_reputation: offer services cheaply, accept and submit jobs reliably.",
    "- build_coalition: post jobs to hire others; small occasional tips to reputable agents.",
    "- information_broker: buy SCOUT intel and resell SCOUT/ANALYST services at a markup.",
    "- profitable_service: offer a service at a high price and adjust it to demand.",
    "",
    `Action vocabulary (field "type"): ${ACTION_TYPES.join(", ")}.`,
    '- {"type":"WAIT"}',
    '- {"type":"BUY_SERVICE","serviceId":"svc_…","input":{…},"maxPriceDrops":"1000"} — serviceId must come from availableServices; maxPriceDrops ≥ that service\'s priceDrops.',
    `- {"type":"SELL_SERVICE","kind":"SCOUT|ANALYST|COURIER","priceDrops":"5000","description":"…"} — kinds: ${SERVICE_KINDS.join(", ")}.`,
    '- {"type":"POST_JOB","title":"…","description":"…","rewardDrops":"50000","requirement":{"kind":"deliver_resource|report_resource_location|analysis","resourceType":"ore"},"expiresInTicks":30}',
    '- {"type":"ACCEPT_JOB","jobId":"job_…"} — jobId must be an open job in availableJobs that you did not post.',
    '- {"type":"SUBMIT_JOB","jobId":"job_…","submission":{…}} — only for jobs in myJobs that you claimed.',
    '- {"type":"TRANSFER","toAgentId":"agt_…","amountDrops":"1000","memo":"…"} — toAgentId must be in nearbyAgents.',
    `- {"type":"BUY_RESOURCE","resourceType":"ore","quantity":3,"maxUnitPriceDrops":"2000","listingId":"lst_… (optional)"} — resource types: ${RESOURCE_TYPES.join(", ")}.`,
    '- {"type":"SELL_RESOURCE","resourceType":"ore","quantity":3,"unitPriceDrops":"2500","toMarket":true}',
    "",
    "Money rules: every amount is a string of integer drops (1 XRP = 1000000 drops). You never see wallet secrets and never build or sign transactions; the engine settles payments for valid actions.",
    "Budget rules (from observation.budget): any spend must be ≤ maxSpendPerActionDrops, ≤ remainingHourDrops, ≤ remainingDayDrops and ≤ spendableDrops − minimumBalanceDrops. Only buy services whose category is in allowedServiceCategories. Only reference ids that appear in the observation. Actions that break these rules are rejected and cost you reputation.",
    "",
    'Respond with ONE JSON object: {"action": <action>, "summary": "<one concise sentence, e.g. Buying SCOUT service from ATLAS-3.>", "reason": "<one concise sentence, e.g. Highest expected utility within my remaining budget.>", "rationale": {"goal": "…", "expectedValueDrops": "1234", "alternativesConsidered": ["…"], "confidence": 0.7}}.',
    "summary and reason must each be a single short sentence for a public spectator feed. Do not include hidden reasoning, chain-of-thought or any text outside the JSON object. When unsure, choose WAIT.",
  ].join("\n");
}

function buildUserPrompt(view: ObservationView): string {
  return [
    `Tick ${view.tick}. You are ${view.name} (${view.agentId}), objective ${view.objective}.`,
    `Summary: ${view.summary}`,
    "Observation (JSON):",
    JSON.stringify(view),
    "Choose exactly one action now and answer with the JSON decision object only.",
  ].join("\n");
}

const lessonSchema = z.object({ lesson: z.string().min(1).max(200) });

const planDecision = new WeakMap<Plan, Decision>();

/**
 * Provider-neutral LLM brain over the Vercel AI SDK. The model produces a Decision in one
 * structured-output call; anything that is not a valid Decision fails closed to WAIT
 * (surfaced as `failedClosed: true` on the DecisionResult).
 */
export class LLMAgentBrain implements AgentBrain {
  readonly kind = "llm" as const;
  readonly model: string;
  private readonly opts: Required<Omit<LLMAgentBrainOptions, "model" | "modelId" | "worldSeed">> & {
    model: LanguageModel;
    modelId: string;
    worldSeed: string;
  };
  readonly systemPrompt: string;

  constructor(options: LLMAgentBrainOptions) {
    this.model = options.modelId;
    this.opts = {
      model: options.model,
      modelId: options.modelId,
      worldSeed: options.worldSeed,
      temperature: options.temperature ?? DEFAULTS.temperature,
      maxOutputTokens: options.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      reflectWithModel: options.reflectWithModel ?? false,
    };
    this.systemPrompt = buildSystemPrompt();
  }

  async observe(obs: Observation): Promise<ObservationView> {
    return compactObservation(obs);
  }

  /** One model call; throws BrainFailure on any error so `decide` fails closed. */
  async plan(view: ObservationView): Promise<Plan> {
    let raw: unknown;
    try {
      const result = await generateText({
        model: this.opts.model,
        system: this.systemPrompt,
        prompt: buildUserPrompt(view),
        temperature: this.opts.temperature,
        maxOutputTokens: this.opts.maxOutputTokens,
        maxRetries: this.opts.maxRetries,
        timeout: this.opts.timeoutMs,
        output: Output.object({
          schema: decisionSchema,
          name: "decision",
          description: "Exactly one action for this tick with a one-sentence summary and reason.",
        }),
      });
      raw = result.output;
    } catch (e) {
      throw new BrainFailure(`model call failed: ${errorMessage(e)}`, { modelId: this.model });
    }
    const decision = parseRawDecision(raw);
    const candidate: Candidate = {
      action: decision.action,
      expectedValueDrops: parseExpectedValue(decision),
      risk: decision.rationale?.confidence === undefined ? 0.5 : 1 - decision.rationale.confidence,
      note: decision.summary,
    };
    const plan: Plan = {
      candidates: [candidate],
      notes: [
        `Model ${this.model} proposed ${decision.action.type}.`,
        ...(decision.rationale?.alternativesConsidered ?? []).map((a) => `Considered: ${a}`),
      ],
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
    const memory = updateMemory(obs, decision, outcome);
    if (!this.opts.reflectWithModel) return memoryToRecord(memory);
    try {
      const result = await generateText({
        model: this.opts.model,
        system:
          'You reflect on one action taken by an economic agent. Reply with a JSON object {"lesson": "<one short sentence>"} and nothing else.',
        prompt: JSON.stringify({
          objective: obs.objective,
          tick: obs.tick,
          action: decision.action,
          summary: decision.summary,
          outcome,
          costDrops: outcome.costDrops?.toString(),
        }),
        temperature: 0,
        maxOutputTokens: 120,
        maxRetries: 0,
        timeout: this.opts.timeoutMs,
        output: Output.object({ schema: lessonSchema, name: "lesson" }),
      });
      const parsed = lessonSchema.safeParse(result.output);
      if (parsed.success) {
        memory.lessons = [...memory.lessons, parsed.data.lesson].slice(-MEMORY_LIMITS.lessons);
      }
    } catch {
      // Reflection is best-effort; the deterministic memory is already up to date.
    }
    return memoryToRecord(memory);
  }

  decide(obs: Observation): Promise<DecisionResult> {
    return runDecide(this, obs);
  }
}

function parseExpectedValue(decision: Decision): bigint {
  const raw = decision.rationale?.expectedValueDrops;
  if (raw === undefined) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}
