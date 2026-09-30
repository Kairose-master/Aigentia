import { afterEach, describe, expect, it, vi } from "vitest";
import { readSnapshot, snapshotKey } from "./snapshot";
import { apiFetch } from "./api";

describe("snapshot keys", () => {
  it("sorts parameters and drops empty values, matching the export script", () => {
    expect(snapshotKey("/api/stats")).toBe("/api/stats");
    expect(snapshotKey("api/events", { limit: 100 })).toBe("/api/events?limit=100");
    expect(snapshotKey("/api/transactions", { limit: 50, cursor: undefined })).toBe(
      "/api/transactions?limit=50",
    );
    expect(
      snapshotKey("/api/transactions", { limit: 50, cursor: "2026-09-30T17:00:00Z|pay_x" }),
    ).toBe("/api/transactions?cursor=2026-09-30T17%3A00%3A00Z%7Cpay_x&limit=50");
  });
});

describe("snapshot data source", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves recorded Testnet responses and never touches the network", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "snapshot");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stats = await apiFetch<{ ledger: string }>("/api/stats", undefined, { expect: "object" });
    expect(stats.error).toBeNull();
    expect(stats.data?.ledger).toBe("testnet");
    const agents = await apiFetch<unknown[]>("/api/agents", undefined, { expect: "array" });
    expect(agents.data?.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("answers NOT_FOUND for routes outside the recording and checks shapes", async () => {
    const missing = await readSnapshot("/api/agents/agt_not_recorded", undefined, "object");
    expect(missing.error?.code).toBe("NOT_FOUND");
    const wrongShape = await readSnapshot("/api/agents", undefined, "object");
    expect(wrongShape.error?.code).toBe("VALIDATION_FAILED");
  });
});
