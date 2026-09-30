import { z } from "zod";
import { PAYMENT_KINDS, SERVICE_CATEGORIES } from "@aigentia/shared";
import {
  assetSchema,
  dropsSchema,
  idSchema,
  positiveDropsSchema,
  txHashSchema,
  xrplAddressSchema,
} from "./common";

/** Per-agent economic safety envelope. Enforced by the PolicyEngine before every payment. */
export const budgetPolicySchema = z.object({
  maxSpendPerActionDrops: dropsSchema,
  maxSpendPerHourDrops: dropsSchema,
  maxDailySpendDrops: dropsSchema,
  allowedAssets: z
    .array(z.enum(["XRP", "RLUSD"]))
    .min(1)
    .default(["XRP"]),
  allowedServiceCategories: z.array(z.enum(SERVICE_CATEGORIES)).default([...SERVICE_CATEGORIES]),
  /** Agent may never spend below this balance (on top of the XRPL base reserve). */
  minimumBalanceDrops: dropsSchema,
});
export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

export const paymentPurposeSchema = z.enum(PAYMENT_KINDS);

/**
 * A PaymentIntent is the ONLY thing an agent decision can produce that moves money.
 * It is created by the game engine from a validated action, evaluated by the PolicyEngine,
 * and executed by a PaymentAdapter. The LLM never sees or signs anything below this line.
 */
export const paymentIntentSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  purpose: paymentPurposeSchema,
  destinationAddress: xrplAddressSchema,
  destinationAgentId: idSchema.nullable(),
  asset: assetSchema,
  /** Drops for XRP, decimal string for issued currencies. */
  amount: positiveDropsSchema.or(z.string().regex(/^\d+(\.\d+)?$/)),
  serviceCategory: z.enum(SERVICE_CATEGORIES).nullable(),
  /** Game action this payment settles (decision id, invocation id, job id…). */
  actionRef: z.object({ kind: z.string(), id: z.string() }),
  memo: z.string().max(200).optional(),
  createdAt: z.string(),
});
export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

export const policyDecisionSchema = z.object({
  approved: z.boolean(),
  /** Machine-readable reasons for denial; empty when approved. */
  violations: z.array(
    z.object({
      rule: z.enum([
        "MAX_SPEND_PER_ACTION",
        "MAX_SPEND_PER_HOUR",
        "MAX_DAILY_SPEND",
        "ASSET_NOT_ALLOWED",
        "CATEGORY_NOT_ALLOWED",
        "MINIMUM_BALANCE",
        "INSUFFICIENT_FUNDS",
        "SELF_PAYMENT",
        "INVALID_DESTINATION",
      ]),
      message: z.string(),
      limitDrops: dropsSchema.optional(),
      attemptedDrops: dropsSchema.optional(),
    }),
  ),
  evaluatedAt: z.string(),
  snapshot: z.object({
    balanceDrops: dropsSchema,
    spentLastHourDrops: dropsSchema,
    spentLastDayDrops: dropsSchema,
  }),
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

/** Proof that a payment settled. Every receipt must reference a verifiable ledger transaction. */
export const paymentReceiptSchema = z.object({
  paymentId: idSchema,
  intentId: idSchema,
  txHash: txHashSchema,
  ledgerIndex: z.number().int().positive(),
  validatedAt: z.string(),
  senderAddress: xrplAddressSchema,
  receiverAddress: xrplAddressSchema,
  asset: assetSchema,
  amount: z.string(),
  /** "testnet" | "mock" — mock receipts are only produced by the clearly labelled MockLedger. */
  ledger: z.enum(["testnet", "mock"]),
  invoiceId: z.string().nullable(),
});
export type PaymentReceipt = z.infer<typeof paymentReceiptSchema>;
