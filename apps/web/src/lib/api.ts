/**
 * Typed fetch helpers for every spectator route served by apps/api.
 *
 * Every helper returns an `ApiResult` and never throws: the API may be down while the
 * dashboard renders, and every page has to degrade to an offline/empty state.
 */
import type {
  AgentProfileDto,
  AgentSummaryDto,
  ExperimentDto,
  JobDto,
  PaymentDto,
  ServiceListingDto,
  StatsDto,
  WorldDto,
  WorldEvent,
} from "@aigentia/protocol";
import type { ErrorCode } from "@aigentia/shared";

export const DEFAULT_API_URL = "http://localhost:4000";
export const DEFAULT_TIMEOUT_MS = 6_000;

export interface ApiError {
  readonly code: ErrorCode;
  readonly message: string;
  /** HTTP status when the API answered; null when it was unreachable or the body was unusable. */
  readonly status: number | null;
  /** True when the API could not be reached at all (connection refused, DNS, timeout). */
  readonly offline: boolean;
}

export type ApiResult<T> =
  { readonly data: T; readonly error: null } | { readonly data: null; readonly error: ApiError };

export interface TransactionsPage {
  readonly payments: PaymentDto[];
  readonly nextCursor: string | null;
}

export interface EventsPage {
  readonly events: WorldEvent[];
  readonly nextCursor: number | null;
}

type QueryValue = string | number | boolean | null | undefined;

const ERROR_CODES: readonly ErrorCode[] = [
  "VALIDATION_FAILED",
  "POLICY_DENIED",
  "INSUFFICIENT_FUNDS",
  "NOT_FOUND",
  "CONFLICT",
  "PAYMENT_FAILED",
  "PAYMENT_UNVERIFIED",
  "X402_MALFORMED",
  "X402_UNTRUSTED",
  "LEDGER_UNAVAILABLE",
  "UNAUTHORIZED",
  "INTERNAL",
];

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base URL of the API without a trailing slash. */
export function apiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  const base = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_API_URL;
  return base.replace(/\/+$/, "");
}

/** Absolute URL for a route, with `undefined`/`null` query values dropped. */
export function apiUrl(path: string, query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return `${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}${qs ? `?${qs}` : ""}`;
}

/** URL of the Server-Sent Events stream (`SseEnvelope` per message). */
export function eventStreamUrl(): string {
  return apiUrl("/api/events/stream");
}

function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "VALIDATION_FAILED";
    case 401:
    case 403:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 502:
    case 503:
    case 504:
      return "LEDGER_UNAVAILABLE";
    default:
      return "INTERNAL";
  }
}

function fail<T>(error: ApiError): ApiResult<T> {
  return { data: null, error };
}

export interface ApiFetchOptions {
  /** "object" or "array": the top-level JSON shape the route promises. */
  readonly expect: "object" | "array";
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Fetch a JSON route. Never throws; every failure becomes an `ApiError` with an
 * `AigentiaError` code so callers can branch on it.
 */
export async function apiFetch<T>(
  path: string,
  query: Record<string, QueryValue> | undefined,
  options: ApiFetchOptions,
): Promise<ApiResult<T>> {
  const url = apiUrl(path, query);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: options.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return fail<T>({
      code: "LEDGER_UNAVAILABLE",
      message: `API unreachable at ${apiBaseUrl()}: ${message}`,
      status: null,
      offline: true,
    });
  }

  let body: unknown = null;
  try {
    const text = await response.text();
    body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return fail<T>({
      code: "INTERNAL",
      message: `API returned unparseable JSON for ${path}: ${message}`,
      status: response.status,
      offline: false,
    });
  }

  if (!response.ok) {
    const code =
      isRecord(body) && isErrorCode(body.code) ? body.code : statusToCode(response.status);
    const message =
      isRecord(body) && typeof body.message === "string"
        ? body.message
        : `API responded ${response.status} for ${path}`;
    return fail<T>({ code, message, status: response.status, offline: false });
  }

  const shapeOk = options.expect === "array" ? Array.isArray(body) : isRecord(body);
  if (!shapeOk) {
    return fail<T>({
      code: "VALIDATION_FAILED",
      message: `API returned an unexpected shape for ${path} (expected ${options.expect})`,
      status: response.status,
      offline: false,
    });
  }
  return { data: body as T, error: null };
}

/** GET /api/stats */
export function getStats(): Promise<ApiResult<StatsDto>> {
  return apiFetch<StatsDto>("/api/stats", undefined, { expect: "object" });
}

/** GET /api/world */
export function getWorld(): Promise<ApiResult<WorldDto>> {
  return apiFetch<WorldDto>("/api/world", undefined, { expect: "object" });
}

/** GET /api/agents?experimentId= */
export function getAgents(params?: {
  experimentId?: string;
}): Promise<ApiResult<AgentSummaryDto[]>> {
  return apiFetch<AgentSummaryDto[]>(
    "/api/agents",
    { experimentId: params?.experimentId },
    { expect: "array" },
  );
}

/** GET /api/agents/:id */
export function getAgent(id: string): Promise<ApiResult<AgentProfileDto>> {
  return apiFetch<AgentProfileDto>(`/api/agents/${encodeURIComponent(id)}`, undefined, {
    expect: "object",
  });
}

/** GET /api/market?kind= (ranked by the deterministic ServiceRanker) */
export function getMarket(params?: { kind?: string }): Promise<ApiResult<ServiceListingDto[]>> {
  return apiFetch<ServiceListingDto[]>("/api/market", { kind: params?.kind }, { expect: "array" });
}

/** GET /api/jobs?status= */
export function getJobs(params?: { status?: string }): Promise<ApiResult<JobDto[]>> {
  return apiFetch<JobDto[]>("/api/jobs", { status: params?.status }, { expect: "array" });
}

/** GET /api/transactions?cursor=&limit= */
export function getTransactions(params?: {
  cursor?: string;
  limit?: number;
}): Promise<ApiResult<TransactionsPage>> {
  return apiFetch<TransactionsPage>(
    "/api/transactions",
    { cursor: params?.cursor, limit: params?.limit },
    { expect: "object" },
  );
}

/** GET /api/events?after=&limit= */
export function getEvents(params?: {
  after?: number;
  limit?: number;
}): Promise<ApiResult<EventsPage>> {
  return apiFetch<EventsPage>(
    "/api/events",
    { after: params?.after, limit: params?.limit },
    { expect: "object" },
  );
}

/** GET /api/experiments */
export function getExperiments(): Promise<ApiResult<ExperimentDto[]>> {
  return apiFetch<ExperimentDto[]>("/api/experiments", undefined, { expect: "array" });
}

/** GET /api/experiments/:id */
export function getExperiment(id: string): Promise<ApiResult<ExperimentDto>> {
  return apiFetch<ExperimentDto>(`/api/experiments/${encodeURIComponent(id)}`, undefined, {
    expect: "object",
  });
}

/** Convenience: unwrap a result to its data or a fallback (offline/empty rendering). */
export function dataOr<T>(result: ApiResult<T>, fallback: T): T {
  return result.error === null ? result.data : fallback;
}
