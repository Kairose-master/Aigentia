import {
  x402PaymentPayloadSchema,
  x402SettlementResponseSchema,
  type X402PaymentPayload,
  type X402SettlementResponse,
} from "@aigentia/protocol";
import { AigentiaError, stableStringify } from "@aigentia/shared";

/** Base64 JSON, the encoding x402 v2 uses for PAYMENT-SIGNATURE and PAYMENT-RESPONSE. */
function encode(value: unknown): string {
  return Buffer.from(stableStringify(value), "utf8").toString("base64");
}

function decodeJson(header: string, what: string): unknown {
  try {
    if (!/^[A-Za-z0-9+/=]+$/.test(header)) throw new Error("not base64");
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new AigentiaError("X402_MALFORMED", `${what} is not base64 JSON`);
  }
}

export function encodePaymentSignature(payload: X402PaymentPayload): string {
  return encode(payload);
}

/** Decode and validate a PAYMENT-SIGNATURE header; X402_MALFORMED on anything unexpected. */
export function decodePaymentSignature(header: string): X402PaymentPayload {
  const parsed = x402PaymentPayloadSchema.safeParse(decodeJson(header, "PAYMENT-SIGNATURE"));
  if (!parsed.success) {
    throw new AigentiaError(
      "X402_MALFORMED",
      "PAYMENT-SIGNATURE does not match the x402 v2 payload",
      {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    );
  }
  return parsed.data;
}

export function encodePaymentResponse(settlement: X402SettlementResponse): string {
  return encode(settlement);
}

/** Decode and validate a PAYMENT-RESPONSE header; X402_MALFORMED on anything unexpected. */
export function decodePaymentResponse(header: string): X402SettlementResponse {
  const parsed = x402SettlementResponseSchema.safeParse(decodeJson(header, "PAYMENT-RESPONSE"));
  if (!parsed.success) {
    throw new AigentiaError(
      "X402_MALFORMED",
      "PAYMENT-RESPONSE is not an x402 settlement response",
    );
  }
  return parsed.data;
}
