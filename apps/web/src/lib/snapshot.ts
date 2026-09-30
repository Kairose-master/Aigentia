import type { ApiResult } from "./api";

/**
 * Recorded-snapshot data source. The export script (scripts/export-snapshot.ts) captured the
 * exact responses of the API routes the pages request; lookups use the same normalised key.
 * The data file is loaded lazily and only on the server, so it never ships to the browser.
 */
export type SnapshotQuery = Record<string, string | number | boolean | null | undefined>;

export interface SnapshotMeta {
  readonly recordedAt: string;
  readonly network: string;
  readonly ledger: "testnet" | "mock";
  readonly source: string;
  readonly routes: number;
}

export interface SnapshotFile {
  readonly meta: SnapshotMeta;
  readonly responses: Record<string, unknown>;
}

/** `path?a=1&b=2` with parameters sorted and empty values dropped. */
export function snapshotKey(path: string, query?: SnapshotQuery): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const params = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]): [string, string] => [k, String(v)])
    .sort(([a], [b]) => a.localeCompare(b));
  if (params.length === 0) return clean;
  return `${clean}?${new URLSearchParams(params).toString()}`;
}

let cached: Promise<SnapshotFile | null> | null = null;

async function loadSnapshot(): Promise<SnapshotFile | null> {
  cached ??= import("../snapshot/testnet-snapshot.json")
    .then((m) => (m.default ?? m) as unknown as SnapshotFile)
    .catch(() => null);
  return cached;
}

export async function readSnapshot<T>(
  path: string,
  query: SnapshotQuery | undefined,
  expect: "object" | "array",
): Promise<ApiResult<T>> {
  const file = await loadSnapshot();
  if (!file) {
    return {
      data: null,
      error: {
        code: "INTERNAL",
        message: "snapshot data is missing from this build",
        status: null,
        offline: true,
      },
    };
  }
  const key = snapshotKey(path, query);
  if (!Object.prototype.hasOwnProperty.call(file.responses, key)) {
    return {
      data: null,
      error: {
        code: "NOT_FOUND",
        message: `not part of the recorded snapshot: ${key}`,
        status: 404,
        offline: false,
      },
    };
  }
  const body = file.responses[key];
  const shapeOk =
    expect === "array"
      ? Array.isArray(body)
      : typeof body === "object" && body !== null && !Array.isArray(body);
  if (!shapeOk) {
    return {
      data: null,
      error: {
        code: "VALIDATION_FAILED",
        message: `snapshot entry ${key} has an unexpected shape`,
        status: null,
        offline: false,
      },
    };
  }
  return { data: body as T, error: null };
}

/** Snapshot metadata for the banner and status pill; null outside snapshot builds. */
export async function getSnapshotMeta(): Promise<SnapshotMeta | null> {
  return (await loadSnapshot())?.meta ?? null;
}
