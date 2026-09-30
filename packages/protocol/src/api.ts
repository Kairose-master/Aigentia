import { z } from "zod";
import { budgetPolicySchema } from "./payments";
import { objectiveSchema, serviceKindSchema } from "./common";
import { worldEventSchema } from "./events";
import { experimentConfigSchema, experimentResultsSchema } from "./experiments";

/** DTOs served by apps/api and consumed by apps/web. Dates are ISO strings, money is drops strings. */
export const agentSummaryDto = z.object({
  id: z.string(),
  name: z.string(),
  objective: objectiveSchema,
  status: z.string(),
  walletAddress: z.string(),
  balanceDrops: z.string(),
  netWorthDrops: z.string(),
  reputation: z.number(),
  locationId: z.string(),
  brain: z.string(),
  experimentId: z.string().nullable(),
  createdAt: z.string(),
  explorerUrl: z.string(),
});
export type AgentSummaryDto = z.infer<typeof agentSummaryDto>;

export const decisionTraceDto = z.object({
  id: z.string(),
  tick: z.number().int(),
  observationSummary: z.string(),
  action: z.record(z.string(), z.unknown()),
  summary: z.string(),
  reason: z.string(),
  costDrops: z.string().nullable(),
  txHash: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  outcome: z.string().nullable(),
  outcomeStatus: z.enum(["pending", "success", "failed", "rejected", "invalid"]),
  brain: z.string(),
  latencyMs: z.number().int().nullable(),
  createdAt: z.string(),
});
export type DecisionTraceDto = z.infer<typeof decisionTraceDto>;

export const paymentDto = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  senderAgentId: z.string().nullable(),
  senderName: z.string().nullable(),
  receiverAgentId: z.string().nullable(),
  receiverName: z.string().nullable(),
  senderAddress: z.string(),
  receiverAddress: z.string(),
  amountDrops: z.string(),
  asset: z.string(),
  txHash: z.string().nullable(),
  ledgerIndex: z.number().int().nullable(),
  explorerUrl: z.string().nullable(),
  ledger: z.enum(["testnet", "mock"]),
  invoiceId: z.string().nullable(),
  actionRef: z.object({ kind: z.string(), id: z.string() }).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  validatedAt: z.string().nullable(),
});
export type PaymentDto = z.infer<typeof paymentDto>;

export const serviceListingDto = z.object({
  id: z.string(),
  kind: serviceKindSchema,
  category: z.string(),
  description: z.string(),
  endpoint: z.string(),
  sellerAgentId: z.string(),
  sellerName: z.string(),
  sellerReputation: z.number(),
  priceDrops: z.string(),
  successfulCalls: z.number().int(),
  failedCalls: z.number().int(),
  avgLatencyMs: z.number(),
  totalRevenueDrops: z.string(),
  score: z.number(),
  status: z.string(),
  lastCalledAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ServiceListingDto = z.infer<typeof serviceListingDto>;

export const jobDto = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  rewardDrops: z.string(),
  status: z.string(),
  posterAgentId: z.string(),
  posterName: z.string(),
  claimedByAgentId: z.string().nullable(),
  claimedByName: z.string().nullable(),
  requirement: z.record(z.string(), z.unknown()).nullable(),
  paymentId: z.string().nullable(),
  txHash: z.string().nullable(),
  createdAtTick: z.number().int(),
  expiresAtTick: z.number().int(),
  createdAt: z.string(),
});
export type JobDto = z.infer<typeof jobDto>;

export const agentProfileDto = z.object({
  agent: agentSummaryDto,
  budgetPolicy: budgetPolicySchema,
  inventory: z.array(
    z.object({ resourceType: z.string(), quantity: z.number().int(), locationId: z.string() }),
  ),
  services: z.array(serviceListingDto),
  jobs: z.array(jobDto),
  payments: z.array(paymentDto),
  decisions: z.array(decisionTraceDto),
  reputationHistory: z.array(
    z.object({
      tick: z.number().int(),
      delta: z.number(),
      reason: z.string(),
      createdAt: z.string(),
    }),
  ),
  balanceHistory: z.array(
    z.object({ tick: z.number().int(), balanceDrops: z.string(), netWorthDrops: z.string() }),
  ),
});
export type AgentProfileDto = z.infer<typeof agentProfileDto>;

export const statsDto = z.object({
  agents: z.number().int(),
  activeAgents: z.number().int(),
  transactions: z.number().int(),
  servicePurchases: z.number().int(),
  activeJobs: z.number().int(),
  volumeDrops: z.string(),
  tick: z.number().int(),
  ledger: z.enum(["testnet", "mock"]),
  network: z.string(),
  updatedAt: z.string(),
});
export type StatsDto = z.infer<typeof statsDto>;

export const worldDto = z.object({
  tick: z.number().int(),
  locations: z.array(z.object({ id: z.string(), name: z.string(), x: z.number(), y: z.number() })),
  resources: z.array(
    z.object({
      id: z.string(),
      resourceType: z.string(),
      locationId: z.string(),
      quantity: z.number().int(),
      basePriceDrops: z.string(),
    }),
  ),
  marketPrices: z.record(
    z.string(),
    z.object({ bidDrops: z.string(), askDrops: z.string(), supply: z.number().int() }),
  ),
  agents: z.array(agentSummaryDto),
});
export type WorldDto = z.infer<typeof worldDto>;

export const experimentDto = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  config: experimentConfigSchema,
  startedAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  results: experimentResultsSchema.nullable(),
  agentCount: z.number().int(),
  createdAt: z.string(),
});
export type ExperimentDto = z.infer<typeof experimentDto>;

export const eventsPageDto = z.object({
  events: z.array(worldEventSchema),
  nextCursor: z.number().int().nullable(),
});

export const createAgentRequestSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9-]+$/i),
  objective: objectiveSchema,
  brain: z.enum(["deterministic", "llm"]).default("deterministic"),
  startingCapitalXrp: z.number().positive().max(1000).default(10),
  budgetPolicy: budgetPolicySchema.partial().optional(),
  services: z
    .array(z.object({ kind: serviceKindSchema, priceDrops: z.string().regex(/^\d+$/) }))
    .default([]),
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
