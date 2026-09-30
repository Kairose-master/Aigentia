import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiUrl,
  dataOr,
  eventStreamUrl,
  getAgent,
  getAgents,
  getStats,
  getTransactions,
} from "./api";

function mockFetch(impl: (url: string) => Promise<Response> | Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => Promise.resolve(impl(String(input)))),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiUrl", () => {
  it("defaults to localhost:4000 and drops empty query values", () => {
    expect(apiUrl("/api/agents", { experimentId: undefined, x: "" })).toBe(
      "http://localhost:4000/api/agents",
    );
    expect(apiUrl("/api/transactions", { cursor: "abc", limit: 50 })).toBe(
      "http://localhost:4000/api/transactions?cursor=abc&limit=50",
    );
    expect(eventStreamUrl()).toBe("http://localhost:4000/api/events/stream");
  });
});

describe("api helpers", () => {
  it("returns data for a successful JSON response", async () => {
    mockFetch(() => new Response(JSON.stringify({ agents: 3, tick: 7 }), { status: 200 }));
    const result = await getStats();
    expect(result.error).toBeNull();
    expect(result.data?.agents).toBe(3);
  });

  it("marks the API offline when fetch rejects (no throw, no unhandled rejection)", async () => {
    mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    const result = await getAgents();
    expect(result.data).toBeNull();
    expect(result.error?.offline).toBe(true);
    expect(result.error?.code).toBe("LEDGER_UNAVAILABLE");
    expect(dataOr(result, [])).toEqual([]);
  });

  it("maps HTTP errors to AigentiaError codes and honours codes from the body", async () => {
    mockFetch(() => new Response(JSON.stringify({ message: "nope" }), { status: 404 }));
    const notFound = await getAgent("agt_missing");
    expect(notFound.error?.code).toBe("NOT_FOUND");
    expect(notFound.error?.status).toBe(404);
    expect(notFound.error?.offline).toBe(false);

    mockFetch(
      () =>
        new Response(JSON.stringify({ code: "POLICY_DENIED", message: "denied" }), { status: 400 }),
    );
    const denied = await getAgent("agt_x");
    expect(denied.error?.code).toBe("POLICY_DENIED");
    expect(denied.error?.message).toBe("denied");
  });

  it("rejects an unexpected top-level shape", async () => {
    mockFetch(() => new Response(JSON.stringify({ payments: [] }), { status: 200 }));
    const agents = await getAgents();
    expect(agents.error?.code).toBe("VALIDATION_FAILED");

    mockFetch(() => new Response("[]", { status: 200 }));
    const page = await getTransactions({ limit: 10 });
    expect(page.error?.code).toBe("VALIDATION_FAILED");
  });

  it("handles unparseable bodies", async () => {
    mockFetch(() => new Response("<html>", { status: 200 }));
    const result = await getStats();
    expect(result.error?.code).toBe("INTERNAL");
  });

  it("sends cache: no-store", async () => {
    mockFetch(() => new Response("[]", { status: 200 }));
    await getAgents({ experimentId: "exp_1" });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(String(call?.[0])).toBe("http://localhost:4000/api/agents?experimentId=exp_1");
    expect(call?.[1]?.cache).toBe("no-store");
  });
});
