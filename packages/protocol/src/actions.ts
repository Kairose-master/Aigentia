import { z } from "zod";
import { idSchema, positiveDropsSchema, resourceTypeSchema, serviceKindSchema } from "./common";

/**
 * MVP action vocabulary. The LLM (or DeterministicAgent) must return exactly one of
 * these. Anything that fails `agentActionSchema.safeParse` is treated as WAIT and
 * recorded as ACTION_INVALID — invalid output fails closed.
 *
 * Amounts are drops strings. No action can reference wallet secrets or raw XRPL
 * transactions; economic actions become PaymentIntents evaluated by the PolicyEngine.
 */
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
export const jsonObjectSchema = z.record(z.string(), jsonValue);

export const waitAction = z.object({
  type: z.literal("WAIT"),
});

export const buyServiceAction = z.object({
  type: z.literal("BUY_SERVICE"),
  serviceId: idSchema,
  input: jsonObjectSchema.default({}),
  /** Hard ceiling the agent is willing to pay for this call, in drops. */
  maxPriceDrops: positiveDropsSchema,
});

export const sellServiceAction = z.object({
  type: z.literal("SELL_SERVICE"),
  kind: serviceKindSchema,
  priceDrops: positiveDropsSchema,
  description: z.string().max(280).optional(),
});

export const postJobAction = z.object({
  type: z.literal("POST_JOB"),
  title: z.string().min(3).max(120),
  description: z.string().min(3).max(1000),
  rewardDrops: positiveDropsSchema,
  /** Optional structured requirement the submission must satisfy. */
  requirement: z
    .object({
      kind: z.enum(["deliver_resource", "report_resource_location", "analysis"]),
      resourceType: resourceTypeSchema.optional(),
      quantity: z.number().int().positive().optional(),
      locationId: z.string().optional(),
    })
    .optional(),
  expiresInTicks: z.number().int().min(1).max(1440).default(60),
});

export const acceptJobAction = z.object({
  type: z.literal("ACCEPT_JOB"),
  jobId: idSchema,
});

export const submitJobAction = z.object({
  type: z.literal("SUBMIT_JOB"),
  jobId: idSchema,
  submission: jsonObjectSchema.default({}),
});

export const transferAction = z.object({
  type: z.literal("TRANSFER"),
  toAgentId: idSchema,
  amountDrops: positiveDropsSchema,
  memo: z.string().max(120).optional(),
});

export const buyResourceAction = z.object({
  type: z.literal("BUY_RESOURCE"),
  resourceType: resourceTypeSchema,
  quantity: z.number().int().min(1).max(1000),
  maxUnitPriceDrops: positiveDropsSchema,
  /** Buy from a specific agent's listing; omit to buy from the world market. */
  listingId: idSchema.optional(),
});

export const sellResourceAction = z.object({
  type: z.literal("SELL_RESOURCE"),
  resourceType: resourceTypeSchema,
  quantity: z.number().int().min(1).max(1000),
  unitPriceDrops: positiveDropsSchema,
  /** true → sell immediately to the world market at its bid; false → post a listing. */
  toMarket: z.boolean().default(true),
});

export const agentActionSchema = z.discriminatedUnion("type", [
  waitAction,
  buyServiceAction,
  sellServiceAction,
  postJobAction,
  acceptJobAction,
  submitJobAction,
  transferAction,
  buyResourceAction,
  sellResourceAction,
]);
export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentActionInput = z.input<typeof agentActionSchema>;

/**
 * What a brain returns. `summary` and `reason` are concise, model-generated text meant
 * for the spectator UI — never hidden chain-of-thought.
 */
export const decisionSchema = z.object({
  action: agentActionSchema,
  /** One sentence, e.g. "Buying SCOUT service from ATLAS-3." */
  summary: z.string().min(1).max(280),
  /** One sentence, e.g. "Highest expected utility within my remaining budget." */
  reason: z.string().min(1).max(400),
  /** Optional structured rationale for analytics. */
  rationale: z
    .object({
      goal: z.string().max(120).optional(),
      expectedValueDrops: z
        .string()
        .regex(/^-?\d+$/)
        .optional(),
      alternativesConsidered: z.array(z.string().max(80)).max(5).optional(),
      confidence: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type Decision = z.infer<typeof decisionSchema>;
export type DecisionInput = z.input<typeof decisionSchema>;

/** The raw shape an LLM is asked to produce (identical to Decision, kept separate for clarity). */
export const llmDecisionOutputSchema = decisionSchema;
