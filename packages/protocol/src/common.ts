import { z } from "zod";
import {
  ASSET_CODES,
  OBJECTIVES,
  RESOURCE_TYPES,
  SERVICE_KINDS,
  SERVICE_CATEGORIES,
  AGENT_STATUSES,
} from "@aigentia/shared";

export const dropsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "expected an integer drops string")
  .refine((v) => BigInt(v) <= 100_000_000_000_000_000n, "exceeds total XRP supply");

export const positiveDropsSchema = dropsSchema.refine((v) => BigInt(v) > 0n, "must be positive");

export const assetSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("XRP") }),
  z.object({
    code: z.enum(ASSET_CODES.filter((c) => c !== "XRP") as ["RLUSD"]),
    issuer: z.string().min(25),
    currencyHex: z.string().regex(/^[0-9A-F]{40}$/),
  }),
]);
export type AssetInput = z.infer<typeof assetSchema>;

export const moneySchema = z.object({
  asset: assetSchema,
  value: z.string().regex(/^\d+(\.\d+)?$/),
});
export type MoneyInput = z.infer<typeof moneySchema>;

export const objectiveSchema = z.enum(OBJECTIVES);
export const resourceTypeSchema = z.enum(RESOURCE_TYPES);
export const serviceKindSchema = z.enum(SERVICE_KINDS);
export const serviceCategorySchema = z.enum(SERVICE_CATEGORIES);
export const agentStatusSchema = z.enum(AGENT_STATUSES);

export const idSchema = z.string().regex(/^[a-z]{3}_[0-9a-z]{6,32}$/, "expected a prefixed id");
export const xrplAddressSchema = z
  .string()
  .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, "expected an XRPL classic address");
export const txHashSchema = z
  .string()
  .regex(/^[0-9A-F]{64}$/i, "expected a 64-hex transaction hash");
export const isoDateSchema = z.string().datetime({ offset: true });
