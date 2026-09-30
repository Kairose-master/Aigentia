import {
  payerBuildResponseSchema,
  x402SettlementResponseSchema,
  x402SupportedResponseSchema,
  x402VerifyResponseSchema,
  type PayerBuildRequest,
  type PayerBuildResponse,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SettlementResponse,
  type X402SupportedResponse,
  type X402VerifyResponse,
} from "@aigentia/protocol";
import { AigentiaError, errorMessage } from "@aigentia/shared";
import type { z } from "zod";

/**
 * The narrow internal API of services/x402-xrpl (or its [MOCK] stand-in). Sellers call
 * verify/settle with THEIR OWN stored requirements; buyers call payerBuild to get an unsigned,
 * autofilled Payment they validate and sign themselves.
 */
export interface Facilitator {
  readonly kind: "http" | "mock";
  supported(): Promise<X402SupportedResponse>;
  verify(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402VerifyResponse>;
  settle(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402SettlementResponse>;
  payerBuild(request: PayerBuildRequest): Promise<PayerBuildResponse>;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpFacilitatorOptions {
  readonly baseUrl: string;
  /** Shared secret sent as X-Internal-Token. */
  readonly token: string;
  readonly fetch?: FetchFn;
  /** Per-request timeout; settle waits for ledger validation so it gets `settleTimeoutMs`. */
  readonly timeoutMs?: number;
  readonly settleTimeoutMs?: number;
}

/** HTTP client for services/x402-xrpl. Every response is schema-validated; failures fail closed. */
export class HttpFacilitator implements Facilitator {
  readonly kind = "http" as const;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(private readonly opts: HttpFacilitatorOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-internal-token": this.opts.token,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AigentiaError(
        "LEDGER_UNAVAILABLE",
        `x402 service unreachable: ${errorMessage(e)}`,
        { path },
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new AigentiaError(
        "X402_MALFORMED",
        `x402 service returned non-JSON (HTTP ${response.status})`,
        { path },
      );
    }
    if (!response.ok) {
      const reason = (json as { error?: unknown } | null)?.error;
      const code =
        response.status === 503
          ? "LEDGER_UNAVAILABLE"
          : response.status === 401
            ? "UNAUTHORIZED"
            : "X402_UNTRUSTED";
      throw new AigentiaError(
        code,
        `x402 service ${path} failed: ${typeof reason === "string" ? reason : `HTTP ${response.status}`}`,
        {
          path,
          status: response.status,
          reason: typeof reason === "string" ? reason : null,
        },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AigentiaError(
        "X402_MALFORMED",
        `x402 service ${path} returned an unexpected shape`,
        { path },
      );
    }
    return parsed.data;
  }

  supported(): Promise<X402SupportedResponse> {
    return this.call(
      "GET",
      "/supported",
      undefined,
      x402SupportedResponseSchema,
      this.opts.timeoutMs ?? 15_000,
    );
  }

  verify(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402VerifyResponse> {
    return this.call(
      "POST",
      "/verify",
      { paymentPayload: payload, paymentRequirements: requirements },
      x402VerifyResponseSchema,
      this.opts.timeoutMs ?? 20_000,
    );
  }

  settle(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402SettlementResponse> {
    return this.call(
      "POST",
      "/settle",
      { paymentPayload: payload, paymentRequirements: requirements },
      x402SettlementResponseSchema,
      this.opts.settleTimeoutMs ?? (requirements.maxTimeoutSeconds + 45) * 1000,
    );
  }

  payerBuild(request: PayerBuildRequest): Promise<PayerBuildResponse> {
    return this.call(
      "POST",
      "/payer/build",
      request,
      payerBuildResponseSchema,
      this.opts.timeoutMs ?? 20_000,
    );
  }
}
