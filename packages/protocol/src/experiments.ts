import { z } from "zod";
import { objectiveSchema } from "./common";
import { budgetPolicySchema } from "./payments";

export const experimentConfigSchema = z.object({
  name: z.string().min(1).max(120),
  durationHours: z
    .number()
    .positive()
    .max(24 * 30),
  agentCount: z.number().int().min(2).max(200),
  startingCapitalXrp: z.number().positive().max(1000),
  humanInterventionAfterStart: z.literal(false).default(false),
  objectiveDistribution: z
    .array(z.object({ objective: objectiveSchema, count: z.number().int().min(0) }))
    .min(1),
  brain: z.enum(["deterministic", "llm"]).default("deterministic"),
  seed: z.string().min(1),
  budgetPolicy: budgetPolicySchema.optional(),
  tickSeconds: z.number().int().min(1).max(3600).optional(),
});
export type ExperimentConfig = z.infer<typeof experimentConfigSchema>;
export type ExperimentConfigInput = z.input<typeof experimentConfigSchema>;

const leaderboardRow = z.object({
  agentId: z.string(),
  name: z.string(),
  valueDrops: z.string(),
  rank: z.number().int(),
});

/**
 * Every figure here is derived from recorded game state and, where money moved, from
 * verified ledger transactions (payments with status=validated and a tx hash).
 */
export const experimentResultsSchema = z.object({
  computedAt: z.string(),
  ticks: z.number().int(),
  wealthLeaderboard: z.array(leaderboardRow),
  revenueLeaderboard: z.array(leaderboardRow),
  serviceUsage: z.array(
    z.object({
      serviceId: z.string(),
      kind: z.string(),
      sellerAgentId: z.string(),
      calls: z.number().int(),
      revenueDrops: z.string(),
      failures: z.number().int(),
    }),
  ),
  mostUsedServices: z.array(
    z.object({
      serviceId: z.string(),
      kind: z.string(),
      sellerName: z.string(),
      calls: z.number().int(),
    }),
  ),
  tradeCount: z.number().int(),
  survival: z.object({
    alive: z.number().int(),
    bankrupt: z.number().int(),
    survivors: z.array(z.string()),
  }),
  economicConcentration: z.object({
    gini: z.number().min(0).max(1),
    top10PercentShare: z.number().min(0).max(1),
  }),
  failedPayments: z.number().int(),
  verifiedPayments: z.number().int(),
  totalVolumeDrops: z.string(),
  networkGraph: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        objective: z.string(),
        netWorthDrops: z.string(),
        status: z.string(),
      }),
    ),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        count: z.number().int(),
        volumeDrops: z.string(),
      }),
    ),
  }),
});
export type ExperimentResults = z.infer<typeof experimentResultsSchema>;
