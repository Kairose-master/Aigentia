export type ErrorCode =
  | "VALIDATION_FAILED"
  | "POLICY_DENIED"
  | "INSUFFICIENT_FUNDS"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYMENT_FAILED"
  | "PAYMENT_UNVERIFIED"
  | "X402_MALFORMED"
  | "X402_UNTRUSTED"
  | "LEDGER_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "INTERNAL";

export class AigentiaError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AigentiaError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isAigentiaError(e: unknown): e is AigentiaError {
  return e instanceof AigentiaError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}
