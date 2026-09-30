import { AigentiaError, XRP, isXrp, newId, nowIso, type Asset } from "@aigentia/shared";
import { z } from "zod";
import { paymentIntentSchema, type PaymentIntent } from "@aigentia/protocol";

const DROPS_RE = /^(0|[1-9][0-9]*)$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const MAX_DROPS = 100_000_000_000_000_000n;

/**
 * The protocol schema's `positiveDropsSchema.or(decimal)` union throws on decimal amounts
 * (its refinement calls BigInt on the raw string), so the amount is validated by hand below
 * and the rest of the shape through the protocol schema.
 */
const intentShapeSchema = paymentIntentSchema.extend({ amount: z.string().regex(DECIMAL_RE) });

export interface CreatePaymentIntentInput {
  readonly agentId: string;
  readonly purpose: PaymentIntent["purpose"];
  readonly destinationAddress: string;
  readonly destinationAgentId?: string | null;
  /** Defaults to XRP. */
  readonly asset?: Asset;
  /** Drops (bigint or drops string) for XRP; decimal string for issued currencies. */
  readonly amount: bigint | string;
  readonly serviceCategory?: PaymentIntent["serviceCategory"];
  readonly actionRef: PaymentIntent["actionRef"];
  readonly memo?: string;
  /** Override for deterministic simulations; defaults to newId("intent"). */
  readonly id?: string;
  /** Override for deterministic simulations; defaults to nowIso(). */
  readonly createdAt?: string;
}

/**
 * The only constructor for PaymentIntents. Validates against the protocol schema so nothing
 * malformed ever reaches the PolicyEngine or a PaymentAdapter.
 */
export function createPaymentIntent(input: CreatePaymentIntentInput): PaymentIntent {
  const asset = input.asset ?? XRP;
  const amount = typeof input.amount === "bigint" ? input.amount.toString() : input.amount;
  const candidate = {
    id: input.id ?? newId("intent"),
    agentId: input.agentId,
    purpose: input.purpose,
    destinationAddress: input.destinationAddress,
    destinationAgentId: input.destinationAgentId ?? null,
    asset,
    amount,
    serviceCategory: input.serviceCategory ?? null,
    actionRef: input.actionRef,
    ...(input.memo !== undefined ? { memo: input.memo } : {}),
    createdAt: input.createdAt ?? nowIso(),
  };
  return validatePaymentIntent(candidate);
}

/**
 * Validate an intent-shaped value against the protocol schema plus the positivity rule the
 * schema alone cannot express for issued currencies. Throws VALIDATION_FAILED.
 */
export function validatePaymentIntent(candidate: unknown): PaymentIntent {
  const parsed = intentShapeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AigentiaError("VALIDATION_FAILED", "invalid payment intent", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const intent = parsed.data;
  if (isXrp(intent.asset)) {
    if (!DROPS_RE.test(intent.amount) || BigInt(intent.amount) <= 0n) {
      throw new AigentiaError("VALIDATION_FAILED", "XRP intents need a positive drops amount", {
        intentId: intent.id,
        amount: intent.amount,
      });
    }
    if (BigInt(intent.amount) > MAX_DROPS) {
      throw new AigentiaError("VALIDATION_FAILED", "XRP amount exceeds total supply", {
        intentId: intent.id,
        amount: intent.amount,
      });
    }
  } else if (Number(intent.amount) <= 0) {
    throw new AigentiaError("VALIDATION_FAILED", "issued-currency intents need a positive amount", {
      intentId: intent.id,
      amount: intent.amount,
    });
  }
  return intent;
}
