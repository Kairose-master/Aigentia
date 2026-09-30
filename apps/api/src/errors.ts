import { isAigentiaError, type ErrorCode } from "@aigentia/shared";

/** JSON body of every error response. `code` is an AigentiaError code the web can branch on. */
export interface ErrorBody {
  readonly code: ErrorCode | "NOT_IMPLEMENTED";
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export function httpStatusForCode(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_FAILED":
    case "X402_MALFORMED":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "X402_UNTRUSTED":
    case "PAYMENT_FAILED":
    case "PAYMENT_UNVERIFIED":
    case "INSUFFICIENT_FUNDS":
      return 402;
    case "POLICY_DENIED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "LEDGER_UNAVAILABLE":
      return 503;
    case "INTERNAL":
      return 500;
  }
}

function codeForHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 413:
    case 415:
    case 422:
      return "VALIDATION_FAILED";
    case 401:
    case 403:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 503:
      return "LEDGER_UNAVAILABLE";
    default:
      return "INTERNAL";
  }
}

export interface MappedError {
  readonly status: number;
  readonly body: ErrorBody;
  /** True for unexpected failures that must be logged with their stack. */
  readonly unexpected: boolean;
}

/**
 * Map any thrown value to a status + body. AigentiaError codes map to HTTP statuses;
 * Fastify's own errors (bad JSON, 404, payload too large) keep their status; anything
 * else is a 500 whose message is never sent to the client.
 */
export function mapError(error: unknown): MappedError {
  if (isAigentiaError(error)) {
    const status = httpStatusForCode(error.code);
    return {
      status,
      unexpected: status >= 500,
      body: {
        code: error.code,
        message: error.message,
        ...(error.details && status < 500 ? { details: error.details } : {}),
      },
    };
  }
  if (error && typeof error === "object") {
    const rec = error as { statusCode?: unknown; validation?: unknown; message?: unknown };
    const statusCode = typeof rec.statusCode === "number" ? rec.statusCode : undefined;
    if (
      rec.validation !== undefined ||
      (statusCode !== undefined && statusCode >= 400 && statusCode < 500)
    ) {
      const status = statusCode ?? 400;
      return {
        status,
        unexpected: false,
        body: {
          code: codeForHttpStatus(status),
          message: typeof rec.message === "string" ? rec.message : "bad request",
        },
      };
    }
  }
  return {
    status: 500,
    unexpected: true,
    body: { code: "INTERNAL", message: "internal server error" },
  };
}
