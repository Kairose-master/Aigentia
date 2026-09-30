import { z } from "zod";
import {
  dropsSchema,
  idSchema,
  objectiveSchema,
  resourceTypeSchema,
  serviceKindSchema,
  xrplAddressSchema,
} from "./common";

/**
 * Structured observation handed to a brain each tick. Agents never get database access;
 * this is the entire world as far as they can see it.
 */
export const observedServiceSchema = z.object({
  id: idSchema,
  kind: serviceKindSchema,
  sellerAgentId: idSchema,
  sellerName: z.string(),
  priceDrops: dropsSchema,
  description: z.string(),
  successRate: z.number().min(0).max(1),
  reputation: z.number().min(0).max(100),
  avgLatencyMs: z.number().min(0),
  totalCalls: z.number().int().min(0),
  /** Deterministic ranker score (higher is better). */
  score: z.number(),
});
export type ObservedService = z.infer<typeof observedServiceSchema>;

export const observedJobSchema = z.object({
  id: idSchema,
  posterAgentId: idSchema,
  posterName: z.string(),
  title: z.string(),
  description: z.string(),
  rewardDrops: dropsSchema,
  status: z.string(),
  claimedByAgentId: idSchema.nullable(),
  requirement: z.record(z.string(), z.unknown()).nullable(),
  expiresAtTick: z.number().int(),
});
export type ObservedJob = z.infer<typeof observedJobSchema>;

export const observedAgentSchema = z.object({
  id: idSchema,
  name: z.string(),
  objective: objectiveSchema,
  reputation: z.number(),
  locationId: z.string(),
  status: z.string(),
  servicesOffered: z.array(serviceKindSchema),
});
export type ObservedAgent = z.infer<typeof observedAgentSchema>;

export const observedListingSchema = z.object({
  id: idSchema,
  sellerAgentId: idSchema,
  resourceType: resourceTypeSchema,
  quantity: z.number().int(),
  unitPriceDrops: dropsSchema,
});

export const observedEventSchema = z.object({
  tick: z.number().int(),
  type: z.string(),
  message: z.string(),
  agentId: idSchema.nullable(),
  counterpartyId: idSchema.nullable(),
});

export const marketPricesSchema = z.record(
  resourceTypeSchema,
  z.object({ bidDrops: dropsSchema, askDrops: dropsSchema, supply: z.number().int() }),
);

export const observationSchema = z.object({
  tick: z.number().int().min(0),
  agentId: idSchema,
  name: z.string(),
  objective: objectiveSchema,
  status: z.string(),
  walletAddress: xrplAddressSchema.or(z.string()),
  /** Ledger balance in drops (spendable balance excludes the XRPL reserve). */
  balanceDrops: dropsSchema,
  spendableDrops: dropsSchema,
  netWorthDrops: dropsSchema,
  reputation: z.number(),
  locationId: z.string(),
  inventory: z.array(
    z.object({
      resourceType: resourceTypeSchema,
      quantity: z.number().int(),
      locationId: z.string(),
    }),
  ),
  budget: z.object({
    maxSpendPerActionDrops: dropsSchema,
    remainingHourDrops: dropsSchema,
    remainingDayDrops: dropsSchema,
    minimumBalanceDrops: dropsSchema,
    allowedServiceCategories: z.array(z.string()),
  }),
  myServices: z.array(
    z.object({
      id: idSchema,
      kind: serviceKindSchema,
      priceDrops: dropsSchema,
      totalCalls: z.number().int(),
      revenueDrops: dropsSchema,
    }),
  ),
  myJobs: z.array(observedJobSchema),
  availableServices: z.array(observedServiceSchema),
  availableJobs: z.array(observedJobSchema),
  resourceListings: z.array(observedListingSchema),
  marketPrices: marketPricesSchema,
  nearbyAgents: z.array(observedAgentSchema),
  recentEvents: z.array(observedEventSchema),
  /** Compact memory carried between ticks (written by reflectOnOutcome). */
  memory: z.record(z.string(), z.unknown()),
  /** Known resource intel purchased from SCOUT services etc. */
  knowledge: z.array(
    z.object({
      resourceType: resourceTypeSchema,
      locationId: z.string(),
      quantity: z.number().int(),
      learnedAtTick: z.number().int(),
    }),
  ),
});
export type Observation = z.infer<typeof observationSchema>;
