import { x402PaymentRequiredSchema } from "@aigentia/protocol";
import { buildTestWorld, type TestWorld } from "@aigentia/game-engine/testing";
import {
  agentProfileDto,
  agentSummaryDto,
  jobDto,
  paymentDto,
  serviceListingDto,
  statsDto,
  worldDto,
  worldEventSchema,
} from "@aigentia/protocol";
import { createLogger } from "@aigentia/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { InMemoryEventBus, bridgeEventLog } from "@aigentia/game-engine";

const ADMIN_TOKEN = "test-admin-token-123";

let world: TestWorld;
let app: FastifyInstance;
let bus: InMemoryEventBus;

async function getJson<T = unknown>(url: string): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json<T>() };
}

beforeAll(async () => {
  world = await buildTestWorld({
    seed: "api-test",
    env: { ADMIN_TOKEN, XRPL_EXPLORER_URL: "https://testnet.xrpl.org" },
    agents: [
      {
        name: "ORION-7",
        objective: "maximize_net_worth",
        capitalXrp: 20,
        services: [{ kind: "SCOUT", priceDrops: "1000" }],
      },
      {
        name: "ATLAS-3",
        objective: "information_broker",
        capitalXrp: 15,
        services: [
          { kind: "SCOUT", priceDrops: "5000" },
          { kind: "ANALYST", priceDrops: "2000" },
        ],
      },
      { name: "NOVA-1", objective: "survive", capitalXrp: 10 },
    ],
  });
  await world.runTicks(3);
  bus = new InMemoryEventBus();
  bridgeEventLog(world.runtime.events, bus);
  app = buildApp({
    env: world.env,
    store: world.store,
    events: bus,
    runtime: world.runtime,
    logger: createLogger("api-test", "silent"),
    sse: { statsIntervalMs: 50, heartbeatIntervalMs: 60, retryMs: 100 },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("reports the ledger and tick", async () => {
    const { status, body } = await getJson<Record<string, unknown>>("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ledger).toBe("mock");
    expect(body.tick).toBe(3);
    expect(body.running).toBe(false);
  });
});

describe("GET /api/stats", () => {
  it("reflects the world after three ticks", async () => {
    const { status, body } = await getJson("/api/stats");
    expect(status).toBe(200);
    const stats = statsDto.parse(body);
    expect(stats.agents).toBe(3);
    expect(stats.activeAgents).toBe(3);
    expect(stats.tick).toBe(3);
    expect(stats.ledger).toBe("mock");
    expect(stats.network).toBe("mock");
    // three funding payments settled on the mock ledger at minimum
    expect(stats.transactions).toBeGreaterThanOrEqual(3);
    expect(BigInt(stats.volumeDrops)).toBeGreaterThanOrEqual(45_000_000n);
    expect(stats.servicePurchases).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /api/world", () => {
  it("returns locations, deposits, prices and agents", async () => {
    const { status, body } = await getJson("/api/world");
    expect(status).toBe(200);
    const dto = worldDto.parse(body);
    expect(dto.tick).toBe(3);
    expect(dto.locations.map((l) => l.id)).toContain("loc_core");
    expect(dto.resources.length).toBeGreaterThan(0);
    expect(Object.keys(dto.marketPrices).sort()).toEqual(["alloy", "data", "energy", "ore"]);
    expect(dto.agents).toHaveLength(3);
  });
});

describe("GET /api/agents", () => {
  it("lists summaries that validate against the DTO schema", async () => {
    const { status, body } = await getJson<unknown[]>("/api/agents");
    expect(status).toBe(200);
    expect(body).toHaveLength(3);
    for (const a of body) {
      const dto = agentSummaryDto.parse(a);
      expect(BigInt(dto.balanceDrops)).toBeGreaterThan(0n);
      expect(BigInt(dto.netWorthDrops)).toBeGreaterThanOrEqual(BigInt(dto.balanceDrops));
      expect(dto.explorerUrl).toBe(""); // mock ledger: no explorer link
      expect(dto.brain).toBe("deterministic");
    }
  });

  it("filters by experimentId", async () => {
    const { body } = await getJson<unknown[]>("/api/agents?experimentId=exp_none");
    expect(body).toEqual([]);
  });

  it("returns a full profile", async () => {
    const orion = world.agent("ORION-7");
    const { status, body } = await getJson(`/api/agents/${orion.id}`);
    expect(status).toBe(200);
    const profile = agentProfileDto.parse(body);
    expect(profile.agent.id).toBe(orion.id);
    expect(profile.services.map((s) => s.kind)).toContain("SCOUT");
    const listed = await world.store.listServices({ sellerAgentId: orion.id });
    expect(profile.services).toHaveLength(listed.length);
    expect(profile.payments.length).toBeGreaterThanOrEqual(1);
    const funding = profile.payments.find((p) => p.kind === "funding");
    expect(funding?.senderName).toBe("TREASURY");
    expect(funding?.receiverName).toBe("ORION-7");
    expect(funding?.ledger).toBe("mock");
    expect(funding?.explorerUrl).toBeNull();
    expect(profile.decisions).toHaveLength(3);
    expect(profile.balanceHistory.map((b) => b.tick)).toEqual([1, 2, 3]);
    expect(profile.budgetPolicy.allowedAssets).toEqual(["XRP"]);
  });

  it("404s for an unknown agent", async () => {
    const { status, body } = await getJson<{ code: string }>("/api/agents/agt_missing");
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });
});

describe("GET /api/market", () => {
  it("ranks every active service, cheapest SCOUT first", async () => {
    const { status, body } = await getJson<unknown[]>("/api/market");
    expect(status).toBe(200);
    const listings = body.map((l) => serviceListingDto.parse(l));
    const active = await world.store.listServices({ status: "active" });
    expect(listings).toHaveLength(active.length);
    expect(listings.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < listings.length; i++) {
      expect(listings[i - 1]?.score).toBeGreaterThanOrEqual(listings[i]?.score ?? 0);
    }
    const scouts = listings.filter((l) => l.kind === "SCOUT");
    const orion = scouts.findIndex((s) => s.sellerName === "ORION-7");
    const atlas = scouts.findIndex((s) => s.sellerName === "ATLAS-3");
    expect(orion).toBeGreaterThanOrEqual(0);
    expect(atlas).toBeGreaterThan(orion); // 1000 drops outranks 5000 drops, all else equal
    expect(scouts[orion]?.priceDrops).toBe("1000");
    expect(scouts[orion]?.category).toBe("intelligence");
    expect(scouts[orion]?.endpoint).toContain(`/services/${scouts[orion]?.id}/invoke`);
  });

  it("filters by kind", async () => {
    const { body } = await getJson<unknown[]>("/api/market?kind=ANALYST");
    const listings = body.map((l) => serviceListingDto.parse(l));
    expect(listings.length).toBeGreaterThanOrEqual(1);
    expect(listings.every((l) => l.kind === "ANALYST")).toBe(true);
    expect(listings.map((l) => l.sellerName)).toContain("ATLAS-3");
  });

  it("rejects an unknown kind", async () => {
    const { status } = await getJson("/api/market?kind=WIZARD");
    expect(status).toBe(404);
  });
});

describe("GET /api/jobs", () => {
  it("returns job DTOs and validates status", async () => {
    const { status, body } = await getJson<unknown[]>("/api/jobs");
    expect(status).toBe(200);
    for (const j of body) jobDto.parse(j);
    const open = await getJson<unknown[]>("/api/jobs?status=open");
    expect(open.status).toBe(200);
    const bad = await getJson("/api/jobs?status=nonsense");
    expect(bad.status).toBe(404);
  });
});

describe("GET /api/transactions", () => {
  it("paginates newest first with an opaque cursor", async () => {
    const all = await getJson<{ payments: unknown[]; nextCursor: string | null }>(
      "/api/transactions?limit=200",
    );
    expect(all.status).toBe(200);
    const everything = all.body.payments.map((p) => paymentDto.parse(p));
    expect(everything.length).toBeGreaterThanOrEqual(3);
    expect(all.body.nextCursor).toBeNull();
    for (let i = 1; i < everything.length; i++) {
      expect((everything[i - 1]?.createdAt ?? "") >= (everything[i]?.createdAt ?? "")).toBe(true);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/api/transactions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: {
        status: number;
        body: { payments: { id: string }[]; nextCursor: string | null };
      } = await getJson(url);
      expect(page.status).toBe(200);
      expect(page.body.payments.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.payments.map((p) => p.id));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 50);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(everything.map((p) => p.id));
  });

  it("rejects a malformed cursor", async () => {
    const { status, body } = await getJson<{ code: string }>("/api/transactions?cursor=garbage");
    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_FAILED");
  });
});

describe("GET /api/events", () => {
  it("returns the latest events and pages forward with after=", async () => {
    const latest = await getJson<{ events: unknown[]; nextCursor: number | null }>(
      "/api/events?limit=5",
    );
    expect(latest.status).toBe(200);
    expect(latest.body.events).toHaveLength(5);
    const events = latest.body.events.map((e) => worldEventSchema.parse(e));
    expect(events.at(-1)?.type).toBe("TICK_FINISHED");
    expect(latest.body.nextCursor).toBe(events.at(-1)?.id);

    const first = await getJson<{ events: { id: number }[]; nextCursor: number | null }>(
      "/api/events?after=0&limit=3",
    );
    expect(first.body.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(first.body.nextCursor).toBe(3);
    const next = await getJson<{ events: { id: number }[] }>("/api/events?after=3&limit=3");
    expect(next.body.events.map((e) => e.id)).toEqual([4, 5, 6]);
  });
});

describe("experiments", () => {
  it("lists nothing on the in-memory store and 404s on get", async () => {
    expect((await getJson("/api/experiments")).body).toEqual([]);
    expect((await getJson("/api/experiments/exp_x")).status).toBe(404);
  });
});

describe("admin routes", () => {
  it("reject a missing or wrong token", async () => {
    const missing = await app.inject({ method: "POST", url: "/api/admin/sim/start" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json<{ code: string }>().code).toBe("UNAUTHORIZED");
    const wrong = await app.inject({
      method: "POST",
      url: "/api/admin/sim/start",
      headers: { "x-admin-token": "nope" },
    });
    expect(wrong.statusCode).toBe(401);
    expect((await world.store.getSimulationState()).running).toBe(false);
  });

  it("creates an agent funded on the mock ledger", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/agents",
      headers: { "x-admin-token": ADMIN_TOKEN },
      payload: {
        name: "VEGA-9",
        objective: "maximize_reputation",
        startingCapitalXrp: 12,
        services: [{ kind: "COURIER", priceDrops: "3000" }],
      },
    });
    expect(res.statusCode).toBe(201);
    const dto = agentSummaryDto.parse(res.json());
    expect(dto.name).toBe("VEGA-9");
    expect(dto.balanceDrops).toBe("12000000");
    const stored = await world.store.getAgentByName("VEGA-9");
    expect(stored?.id).toBe(dto.id);
    const funding = (await world.store.listPaymentsForAgent(dto.id)).find(
      (p) => p.kind === "funding",
    );
    expect(funding?.status).toBe("validated");
    expect(funding?.ledger).toBe("mock");
    expect(bus.published.some((e) => e.type === "AGENT_CREATED" && e.agentId === dto.id)).toBe(
      true,
    );
    const market = await getJson<{ kind: string }[]>("/api/market?kind=COURIER");
    expect(market.body.map((s) => s.kind)).toEqual(["COURIER"]);
  });

  it("validates the agent request body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/agents",
      headers: { "x-admin-token": ADMIN_TOKEN },
      payload: { name: "x", objective: "conquer" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe("VALIDATION_FAILED");
  });

  it("409s on a duplicate name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/agents",
      headers: { "x-admin-token": ADMIN_TOKEN },
      payload: { name: "ORION-7", objective: "survive" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe("CONFLICT");
  });

  it("starts, ticks and stops the simulation", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/admin/sim/start",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json<{ running: boolean }>().running).toBe(true);

    const tick = await app.inject({
      method: "POST",
      url: "/api/admin/sim/tick",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(tick.statusCode).toBe(200);
    const summary = tick.json<{ tick: number; agentsProcessed: number; decisions: unknown[] }>();
    expect(summary.tick).toBe(4);
    expect(summary.agentsProcessed).toBe(4);
    expect(summary.decisions).toHaveLength(4);
    expect((await getJson<{ tick: number }>("/api/stats")).body.tick).toBe(4);

    const stop = await app.inject({
      method: "POST",
      url: "/api/admin/sim/stop",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(stop.json<{ running: boolean }>().running).toBe(false);
  });

  it("answers 501 for experiment lifecycle routes", async () => {
    for (const url of [
      "/api/admin/experiments",
      "/api/admin/experiments/exp_1/start",
      "/api/admin/experiments/exp_1/finish",
    ]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { "x-admin-token": ADMIN_TOKEN },
        payload: {},
      });
      expect(res.statusCode).toBe(501);
      expect(res.json<{ message: string }>().message).toMatch(/Phase 5/);
    }
  });
});

describe("POST /services/:id/invoke", () => {
  it("answers an unpaid call with HTTP 402 and x402 v2 payment requirements", async () => {
    const [service] = await world.store.listServices({ kind: "SCOUT" });
    const res = await app.inject({
      method: "POST",
      url: `/services/${service?.id}/invoke`,
      payload: { input: {} },
    });
    expect(res.statusCode).toBe(402);
    const body = x402PaymentRequiredSchema.parse(res.json());
    expect(body.accepts[0]?.amount).toBe(service?.priceDrops.toString());
    expect(body.accepts[0]?.extra?.invoiceId).toBeTruthy();
    const bad = await app.inject({
      method: "POST",
      url: `/services/${service?.id}/invoke`,
      headers: { "payment-signature": "not-a-receipt" },
      payload: { input: {} },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/services/svc_nope/invoke",
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("error handling", () => {
  it("returns JSON 404 for unknown routes and 400 for bad JSON without stack traces", async () => {
    const nf = await app.inject({ method: "GET", url: "/nope" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json<{ code: string }>().code).toBe("NOT_FOUND");
    const bad = await app.inject({
      method: "POST",
      url: "/api/admin/agents",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at .*\.ts:\d+/);
  });

  it("sends CORS headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});
