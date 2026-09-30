/**
 * API URL helpers. Kept free of any data-loading code so client components (the SSE provider)
 * can import them without pulling the server-side data layer or the snapshot into the browser.
 */
export const DEFAULT_API_URL = "http://localhost:4000";

export type QueryValue = string | number | boolean | null | undefined;

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
