import { buildTestWorld } from "@aigentia/game-engine/testing";
import { sseEnvelopeSchema, type WorldEvent } from "@aigentia/protocol";
import { createLogger } from "@aigentia/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { InMemoryEventBus } from "@aigentia/game-engine";
import { SSE_HEADERS, formatSseEnvelope, sseComment, sseRetry } from "./sse";

describe("formatSseEnvelope", () => {
  it("serialises event/stats/heartbeat envelopes on the wire", () => {
    const heartbeat = formatSseEnvelope({
      channel: "heartbeat",
      data: { at: "2026-01-01T00:00:00.000Z" },
    });
    expect(heartbeat).toBe(
      'event: heartbeat\ndata: {"channel":"heartbeat","data":{"at":"2026-01-01T00:00:00.000Z"}}\n\n',
    );
    const event: WorldEvent = {
      id: 7,
      tick: 1,
      type: "TICK_STARTED",
      message: "line one\nline two",
      agentId: null,
      counterpartyId: null,
      experimentId: null,
      txHash: null,
      amountDrops: null,
      payload: {},
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const wire = formatSseEnvelope({ channel: "event", data: event }, event.id);
    expect(wire.startsWith("id: 7\nevent: event\ndata: ")).toBe(true);
    expect(wire.endsWith("\n\n")).toBe(true);
    const data = wire
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .join("");
    expect(sseEnvelopeSchema.parse(JSON.parse(data))).toEqual({ channel: "event", data: event });
    expect(sseComment("hi\nthere")).toBe(": hi there\n\n");
    expect(sseRetry(2500)).toBe("retry: 2500\n\n");
    expect(SSE_HEADERS["content-type"]).toMatch(/text\/event-stream/);
  });
});

describe("GET /api/events/stream", () => {
  it("sends headers, an initial stats envelope, heartbeats and live events", async () => {
    const world = await buildTestWorld({
      seed: "sse-test",
      agents: [{ name: "ORION-7", objective: "survive", capitalXrp: 5 }],
    });
    const bus = new InMemoryEventBus();
    const app = buildApp({
      env: world.env,
      store: world.store,
      events: bus,
      runtime: world.runtime,
      logger: createLogger("api-test", "silent"),
      sse: { statsIntervalMs: 40, heartbeatIntervalMs: 30, retryMs: 100 },
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    try {
      const res = await fetch(`${address}/api/events/stream`, {
        signal: controller.signal,
        headers: { origin: "http://localhost:3000" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      expect(res.headers.get("cache-control")).toMatch(/no-cache/);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("no body");
      const decoder = new TextDecoder();
      let buffer = "";
      const published: WorldEvent = {
        id: 999,
        tick: 0,
        type: "AGENT_CREATED",
        message: "hello from the bus",
        agentId: null,
        counterpartyId: null,
        experimentId: null,
        txHash: null,
        amountDrops: null,
        payload: {},
        createdAt: new Date().toISOString(),
      };
      let sent = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (!sent && buffer.includes("event: stats")) {
          sent = true;
          await bus.publish(published);
        }
        if (
          buffer.includes("event: heartbeat") &&
          buffer.includes("hello from the bus") &&
          buffer.includes("event: stats")
        ) {
          break;
        }
      }
      expect(buffer.startsWith("retry: 100\n\n: connected\n\n")).toBe(true);
      const frames = buffer
        .split("\n\n")
        .filter((f) => f.startsWith("event: ") || f.startsWith("id: "))
        .map((f) => {
          const data = f
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("");
          return sseEnvelopeSchema.parse(JSON.parse(data));
        });
      const channels = new Set(frames.map((f) => f.channel));
      expect(channels).toEqual(new Set(["stats", "heartbeat", "event"]));
      const stats = frames.find((f) => f.channel === "stats");
      expect(stats?.channel === "stats" && stats.data.agents).toBe(1);
      const event = frames.find((f) => f.channel === "event");
      expect(event?.channel === "event" && event.data.message).toBe("hello from the bus");
      expect(buffer).toContain("id: 999\nevent: event");
    } finally {
      controller.abort();
      await app.close();
    }
  });
});
