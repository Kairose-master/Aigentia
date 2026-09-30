import { z } from "zod";
import type { Decision, Observation } from "@aigentia/protocol";
import type { ExecutionOutcome } from "./brain";

/**
 * Strategy memory carried on `agents.strategy` between ticks. Everything is
 * JSON-serialisable (drops are strings) and every field is parsed leniently so a
 * corrupted or foreign blob degrades to defaults instead of crashing a brain.
 */
const dropsString = z.string().regex(/^(0|[1-9][0-9]*)$/);
const intRecord = z.record(z.string(), z.number().int().min(0));
const dropsRecord = z.record(z.string(), dropsString);

export const agentMemorySchema = z.object({
  version: z.literal(1).catch(1),
  lastTick: z.number().int().catch(-1),
  lastAction: z
    .object({
      tick: z.number().int(),
      type: z.string(),
      status: z.enum(["success", "failed", "rejected", "invalid"]),
      outcome: z.string().max(200),
      costDrops: dropsString.optional(),
    })
    .nullable()
    .catch(null),
  consecutiveFailures: z.number().int().min(0).catch(0),
  ticksSinceLastPurchase: z.number().int().min(0).catch(1_000),
  lastPurchaseTick: z.number().int().nullable().catch(null),
  lastTipTick: z.number().int().nullable().catch(null),
  lastJobPostTick: z.number().int().nullable().catch(null),
  lastListingTick: z.number().int().nullable().catch(null),
  purchasedServiceIds: z.array(z.string()).catch([]),
  failedServiceIds: z.array(z.string()).catch([]),
  /** Target listing price per service kind, adjusted from observed demand. */
  priceDrops: dropsRecord.catch({}),
  /** totalCalls per offered kind at the last reflection. */
  serviceCalls: intRecord.catch({}),
  /** Ticks without a new call per offered kind. */
  idleTicks: intRecord.catch({}),
  /** Exponential moving average of the market ask per resource type. */
  askEmaDrops: dropsRecord.catch({}),
  /** Unit cost basis per resource type from the last successful purchase. */
  costBasisDrops: dropsRecord.catch({}),
  /** Optional free-text lessons (LLM reflection); bounded. */
  lessons: z.array(z.string().max(200)).max(5).catch([]),
});
export type AgentMemory = z.infer<typeof agentMemorySchema>;

export const MEMORY_LIMITS = {
  purchasedServiceIds: 20,
  failedServiceIds: 20,
  lessons: 5,
  idleTicksBeforeDiscount: 5,
  minServicePriceDrops: 1_000n,
} as const;

/** Lenient parse: never throws, unknown keys are dropped, bad values fall back to defaults. */
export function parseMemory(raw: unknown): AgentMemory {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const parsed = agentMemorySchema.safeParse(source);
  return parsed.success ? parsed.data : agentMemorySchema.parse({});
}

function pushBounded(list: readonly string[], value: string, max: number): string[] {
  const next = list.filter((v) => v !== value);
  next.push(value);
  return next.slice(-max);
}

function bump(value: bigint, percent: bigint): bigint {
  return (value * percent) / 100n;
}

/**
 * Deterministic, objective-agnostic memory update used by DeterministicAgent and as the
 * default (no extra model call) reflection of LLMAgentBrain.
 */
export function updateMemory(
  obs: Observation,
  decision: Decision,
  outcome: ExecutionOutcome,
  previous: unknown = obs.memory,
): AgentMemory {
  const prev = parseMemory(previous);
  const action = decision.action;
  const success = outcome.status === "success";

  const next: AgentMemory = {
    ...prev,
    version: 1,
    lastTick: obs.tick,
    lastAction: {
      tick: obs.tick,
      type: action.type,
      status: outcome.status,
      outcome: outcome.outcome.slice(0, 200),
      ...(outcome.costDrops !== undefined ? { costDrops: outcome.costDrops.toString() } : {}),
    },
    consecutiveFailures: success ? 0 : prev.consecutiveFailures + 1,
    ticksSinceLastPurchase: Math.min(prev.ticksSinceLastPurchase + 1, 100_000),
    purchasedServiceIds: [...prev.purchasedServiceIds],
    failedServiceIds: [...prev.failedServiceIds],
    priceDrops: { ...prev.priceDrops },
    serviceCalls: { ...prev.serviceCalls },
    idleTicks: { ...prev.idleTicks },
    askEmaDrops: { ...prev.askEmaDrops },
    costBasisDrops: { ...prev.costBasisDrops },
    lessons: [...prev.lessons],
  };

  if (action.type === "BUY_SERVICE") {
    if (success) {
      next.ticksSinceLastPurchase = 0;
      next.lastPurchaseTick = obs.tick;
      next.purchasedServiceIds = pushBounded(
        prev.purchasedServiceIds,
        action.serviceId,
        MEMORY_LIMITS.purchasedServiceIds,
      );
    } else {
      next.failedServiceIds = pushBounded(
        prev.failedServiceIds,
        action.serviceId,
        MEMORY_LIMITS.failedServiceIds,
      );
    }
  }
  if (action.type === "TRANSFER" && success) next.lastTipTick = obs.tick;
  if (action.type === "POST_JOB" && success) next.lastJobPostTick = obs.tick;
  if (action.type === "SELL_SERVICE" && success) {
    next.priceDrops[action.kind] = action.priceDrops;
    next.lastListingTick = obs.tick;
  }
  if (action.type === "BUY_RESOURCE" && success) {
    const unit =
      outcome.costDrops !== undefined && action.quantity > 0
        ? outcome.costDrops / BigInt(action.quantity)
        : BigInt(action.maxUnitPriceDrops);
    next.costBasisDrops[action.resourceType] = unit.toString();
  }
  if (action.type === "SELL_RESOURCE" && success) {
    const held = obs.inventory
      .filter((i) => i.resourceType === action.resourceType)
      .reduce((s, i) => s + i.quantity, 0);
    if (held <= action.quantity) delete next.costBasisDrops[action.resourceType];
  }

  for (const [resourceType, price] of Object.entries(obs.marketPrices)) {
    const ask = BigInt(price.askDrops);
    const prevEma = prev.askEmaDrops[resourceType];
    const ema = prevEma === undefined ? ask : (BigInt(prevEma) * 3n + ask) / 4n;
    next.askEmaDrops[resourceType] = ema.toString();
  }

  for (const service of obs.myServices) {
    const prevCalls = prev.serviceCalls[service.kind] ?? service.totalCalls;
    const gained = service.totalCalls > prevCalls;
    next.serviceCalls[service.kind] = service.totalCalls;
    const target = BigInt(next.priceDrops[service.kind] ?? service.priceDrops);
    if (gained) {
      next.idleTicks[service.kind] = 0;
      next.priceDrops[service.kind] = bump(
        target > BigInt(service.priceDrops) ? target : BigInt(service.priceDrops),
        110n,
      ).toString();
    } else {
      const idle = (prev.idleTicks[service.kind] ?? 0) + 1;
      if (idle >= MEMORY_LIMITS.idleTicksBeforeDiscount) {
        next.idleTicks[service.kind] = 0;
        const discounted = bump(target, 90n);
        next.priceDrops[service.kind] = (
          discounted < MEMORY_LIMITS.minServicePriceDrops
            ? MEMORY_LIMITS.minServicePriceDrops
            : discounted
        ).toString();
      } else {
        next.idleTicks[service.kind] = idle;
      }
    }
  }

  return next;
}

/** Plain JSON object view (what the engine persists). */
export function memoryToRecord(memory: AgentMemory): Record<string, unknown> {
  return JSON.parse(JSON.stringify(memory)) as Record<string, unknown>;
}
