import { buildTestWorld } from "@aigentia/game-engine/testing";
import { AigentiaError } from "@aigentia/shared";
import { describe, expect, it } from "vitest";
import { mapError } from "./errors";
import {
  WorldStoreReadModel,
  comparePaymentsDesc,
  decodePaymentsCursor,
  encodePaymentsCursor,
} from "./read-model";

describe("payments cursor", () => {
  it("round-trips and rejects garbage", () => {
    const at = new Date("2026-01-01T00:00:05.000Z");
    const cursor = encodePaymentsCursor({ createdAt: at, id: "pay_abc" });
    expect(cursor).toBe("2026-01-01T00:00:05.000Z|pay_abc");
    expect(decodePaymentsCursor(cursor)).toEqual({ createdAt: at, id: "pay_abc" });
    for (const bad of ["", "garbage", "notadate|pay_1", "2026-01-01T00:00:05.000Z|"]) {
      expect(() => decodePaymentsCursor(bad)).toThrow(AigentiaError);
    }
  });

  it("orders newest first with id as a tie breaker", () => {
    const t0 = new Date(0);
    const t1 = new Date(1000);
    const rows = [
      { createdAt: t0, id: "pay_a" },
      { createdAt: t1, id: "pay_a" },
      { createdAt: t1, id: "pay_b" },
    ].sort(comparePaymentsDesc);
    expect(rows.map((r) => `${r.createdAt.getTime()}:${r.id}`)).toEqual([
      "1000:pay_b",
      "1000:pay_a",
      "0:pay_a",
    ]);
  });
});

describe("WorldStoreReadModel", () => {
  it("aggregates payments, jobs and events from the store", async () => {
    const world = await buildTestWorld({
      seed: "read-model",
      agents: [
        { name: "A-1", objective: "survive", capitalXrp: 5 },
        { name: "B-2", objective: "survive", capitalXrp: 7 },
      ],
    });
    await world.runTicks(2);
    const model = new WorldStoreReadModel(world.store);
    const totals = await model.paymentTotals();
    expect(totals.validated).toBeGreaterThanOrEqual(2);
    expect(totals.volumeDrops).toBeGreaterThanOrEqual(12_000_000n);

    const all = await model.listPayments({ limit: 100 });
    const first = await model.listPayments({ limit: 1 });
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe(all[0]?.id);
    const rest = await model.listPayments({
      limit: 100,
      cursor: { createdAt: first[0]?.createdAt ?? new Date(), id: first[0]?.id ?? "" },
    });
    expect(rest.map((p) => p.id)).toEqual(all.slice(1).map((p) => p.id));

    expect(await model.countActiveJobs()).toBeGreaterThanOrEqual(0);
    const latest = await model.eventsAfter(null, 3);
    expect(latest).toHaveLength(3);
    const ids = latest.map((e) => e.id ?? 0);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const after = await model.eventsAfter(ids[0] ?? 0, 10);
    expect(after[0]?.id).toBe(ids[1]);
    expect(await model.listExperiments()).toEqual([]);
    expect((await model.countAgentsByExperiment()).size).toBe(0);
  });
});

describe("mapError", () => {
  it("maps AigentiaError codes to statuses and hides internals", () => {
    expect(mapError(new AigentiaError("VALIDATION_FAILED", "bad")).status).toBe(400);
    expect(mapError(new AigentiaError("UNAUTHORIZED", "no")).status).toBe(401);
    expect(mapError(new AigentiaError("PAYMENT_FAILED", "no")).status).toBe(402);
    expect(mapError(new AigentiaError("X402_UNTRUSTED", "no")).status).toBe(402);
    expect(mapError(new AigentiaError("X402_MALFORMED", "no")).status).toBe(400);
    expect(mapError(new AigentiaError("POLICY_DENIED", "no")).status).toBe(403);
    expect(mapError(new AigentiaError("NOT_FOUND", "no")).status).toBe(404);
    expect(mapError(new AigentiaError("CONFLICT", "no")).status).toBe(409);
    expect(mapError(new AigentiaError("LEDGER_UNAVAILABLE", "no")).status).toBe(503);
    const internal = mapError(new AigentiaError("INTERNAL", "secret detail", { key: "x" }));
    expect(internal.status).toBe(500);
    expect(internal.body.details).toBeUndefined();
    const unknown = mapError(new Error("stack trace here"));
    expect(unknown).toEqual({
      status: 500,
      unexpected: true,
      body: { code: "INTERNAL", message: "internal server error" },
    });
    const fastify = mapError({ statusCode: 415, message: "unsupported media type" });
    expect(fastify.status).toBe(415);
    expect(fastify.body.code).toBe("VALIDATION_FAILED");
  });
});
