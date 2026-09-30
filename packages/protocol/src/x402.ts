import { z } from "zod";
import { xrplAddressSchema } from "./common";

/**
 * x402 v2 wire types for the XRPL "exact" (presigned Payment) scheme, mirroring the
 * official x402-xrpl Python SDK (`x402_xrpl.types`). Every remote 402 response is
 * parsed through these schemas and then validated by `packages/x402` before any
 * PaymentIntent is created. Unknown or malformed input fails closed.
 */
export const x402NetworkSchema = z.enum(["xrpl:0", "xrpl:1", "xrpl:2"]);
export type X402Network = z.infer<typeof x402NetworkSchema>;

export const x402ResourceInfoSchema = z.object({
  url: z.string().min(1),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type X402ResourceInfo = z.infer<typeof x402ResourceInfoSchema>;

export const x402PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: x402NetworkSchema,
  /** XRP: drops string. IOU: decimal value string. */
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  /** "XRP" or a 3-char / 40-hex XRPL currency code. */
  asset: z.string().min(1),
  payTo: xrplAddressSchema,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z
    .object({
      invoiceId: z.string().min(1).max(128).optional(),
      sourceTag: z.number().int().min(0).max(4294967295).optional(),
      destinationTag: z.number().int().min(0).max(4294967295).optional(),
      issuer: z.string().optional(),
      facilitator: z
        .object({ id: z.string().min(1).max(64), name: z.string().max(128).optional() })
        .optional(),
      crossCurrency: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});
export type X402PaymentRequirements = z.infer<typeof x402PaymentRequirementsSchema>;

/** Body of an HTTP 402 response. */
export const x402PaymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  resource: x402ResourceInfoSchema,
  accepts: z.array(x402PaymentRequirementsSchema).min(1),
  error: z.string().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type X402PaymentRequired = z.infer<typeof x402PaymentRequiredSchema>;

/** Decoded PAYMENT-SIGNATURE header (base64 JSON). */
export const x402PaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: x402ResourceInfoSchema.optional(),
  accepted: x402PaymentRequirementsSchema,
  payload: z.object({
    signedTxBlob: z.string().regex(/^[0-9A-F]+$/i),
    invoiceId: z.string().min(1),
  }),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type X402PaymentPayload = z.infer<typeof x402PaymentPayloadSchema>;

/** Facilitator /verify response. */
export const x402VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().nullable().optional(),
  payer: z.string().nullable().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type X402VerifyResponse = z.infer<typeof x402VerifyResponseSchema>;

/** Facilitator /settle response and decoded PAYMENT-RESPONSE header. */
export const x402SettlementResponseSchema = z.object({
  success: z.boolean(),
  transaction: z.string(),
  network: z.string(),
  payer: z.string().nullable().optional(),
  errorReason: z.string().nullable().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type X402SettlementResponse = z.infer<typeof x402SettlementResponseSchema>;

export const x402SupportedResponseSchema = z.object({
  kinds: z.array(
    z.object({ x402Version: z.number().int(), scheme: z.string(), network: z.string() }),
  ),
  extensions: z.array(z.string()).optional(),
  signers: z.record(z.string(), z.array(z.string())).optional(),
});
export type X402SupportedResponse = z.infer<typeof x402SupportedResponseSchema>;

/** Header names used by the x402 v2 protocol. */
export const X402_HEADERS = {
  paymentSignature: "payment-signature",
  paymentResponse: "payment-response",
} as const;

/**
 * Generic paid-service descriptor. Every agent-exposed service is one of these; the
 * marketplace, the ranker and the buyer flow only ever deal with this shape.
 */
export const jsonSchemaSchema = z.record(z.string(), z.unknown());

export const paidServiceSchema = z.object({
  id: z.string(),
  sellerAgentId: z.string(),
  kind: z.enum(["SCOUT", "ANALYST", "COURIER"]),
  endpoint: z.url(),
  description: z.string(),
  price: z.object({ asset: z.object({ code: z.string() }).passthrough(), value: z.string() }),
  inputSchema: jsonSchemaSchema,
  outputSchema: jsonSchemaSchema,
});
export type PaidService = z.infer<typeof paidServiceSchema>;

/** Internal API of services/x402-xrpl (Python) used by the TypeScript side. */
export const payerBuildRequestSchema = z.object({
  account: xrplAddressSchema,
  paymentRequirements: x402PaymentRequirementsSchema,
  resource: x402ResourceInfoSchema.optional(),
  /** Payer-side fee ceiling in drops. */
  maxFeeDrops: z.number().int().positive().default(10_000),
});
export type PayerBuildRequest = z.infer<typeof payerBuildRequestSchema>;

export const payerBuildResponseSchema = z.object({
  invoiceId: z.string(),
  /** xrpl.js-compatible unsigned Payment transaction JSON, autofilled (Sequence, Fee, LastLedgerSequence). */
  unsignedTx: z.record(z.string(), z.unknown()),
  lastLedgerSequence: z.number().int(),
  networkId: z.number().int(),
});
export type PayerBuildResponse = z.infer<typeof payerBuildResponseSchema>;
