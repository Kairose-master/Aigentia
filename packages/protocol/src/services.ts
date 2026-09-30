import { z } from "zod";
import { resourceTypeSchema } from "./common";

/**
 * Input/output contracts for the three seed services. Both the seller (executes) and the
 * buyer (verifies the result) validate against these. JSON Schema versions are published
 * in the marketplace so foreign agents can call them.
 */
export const scoutInputSchema = z.object({
  resourceType: resourceTypeSchema.optional(),
  locationId: z.string().optional(),
});
export const scoutOutputSchema = z.object({
  tick: z.number().int(),
  sightings: z.array(
    z.object({
      resourceType: resourceTypeSchema,
      locationId: z.string(),
      locationName: z.string(),
      quantity: z.number().int().min(0),
      basePriceDrops: z.string(),
    }),
  ),
});
export type ScoutInput = z.infer<typeof scoutInputSchema>;
export type ScoutOutput = z.infer<typeof scoutOutputSchema>;

export const analystInputSchema = z.object({
  resourceType: resourceTypeSchema.optional(),
  horizonTicks: z.number().int().min(1).max(100).default(10),
});
export const analystOutputSchema = z.object({
  tick: z.number().int(),
  reports: z.array(
    z.object({
      resourceType: resourceTypeSchema,
      bidDrops: z.string(),
      askDrops: z.string(),
      supply: z.number().int(),
      trend: z.enum(["rising", "falling", "flat"]),
      volatility: z.number().min(0),
      recommendation: z.enum(["buy", "sell", "hold"]),
      cheapestListingUnitPriceDrops: z.string().nullable(),
    }),
  ),
});
export type AnalystInput = z.infer<typeof analystInputSchema>;
export type AnalystOutput = z.infer<typeof analystOutputSchema>;

export const courierInputSchema = z.object({
  resourceType: resourceTypeSchema,
  quantity: z.number().int().min(1).max(1000),
  fromLocationId: z.string(),
  toLocationId: z.string(),
});
export const courierOutputSchema = z.object({
  tick: z.number().int(),
  moved: z.object({
    resourceType: resourceTypeSchema,
    quantity: z.number().int(),
    fromLocationId: z.string(),
    toLocationId: z.string(),
  }),
  distance: z.number().min(0),
});
export type CourierInput = z.infer<typeof courierInputSchema>;
export type CourierOutput = z.infer<typeof courierOutputSchema>;

export const SERVICE_SCHEMAS = {
  SCOUT: { input: scoutInputSchema, output: scoutOutputSchema },
  ANALYST: { input: analystInputSchema, output: analystOutputSchema },
  COURIER: { input: courierInputSchema, output: courierOutputSchema },
} as const;

export function serviceJsonSchemas(kind: keyof typeof SERVICE_SCHEMAS): {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
} {
  const s = SERVICE_SCHEMAS[kind];
  return {
    inputSchema: z.toJSONSchema(s.input) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(s.output) as Record<string, unknown>,
  };
}
