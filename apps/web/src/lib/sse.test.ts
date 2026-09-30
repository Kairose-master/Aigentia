import { describe, expect, it } from "vitest";
import { eventKey, parseSseEnvelope } from "./sse";

const event = {
  id: 12,
  tick: 4,
  type: "PAYMENT_VALIDATED",
  message: "ORION-7 paid ATLAS-3",
  txHash: "ABC",
  amountDrops: "1000",
  createdAt: "2026-09-30T12:00:00Z",
};

describe("parseSseEnvelope", () => {
  it("parses enveloped messages", () => {
    const parsed = parseSseEnvelope(JSON.stringify({ channel: "event", data: event }));
    expect(parsed?.channel).toBe("event");
    if (parsed?.channel === "event") {
      expect(parsed.data.message).toBe(event.message);
      expect(parsed.data.agentId).toBeNull();
      expect(parsed.data.payload).toEqual({});
      expect(eventKey(parsed.data)).toBe("id:12");
    }
  });
  it("uses the SSE event name when the payload is bare", () => {
    const parsed = parseSseEnvelope(
      JSON.stringify({
        agents: 1,
        transactions: 2,
        servicePurchases: 3,
        activeJobs: 4,
        volumeDrops: "5",
        tick: 6,
      }),
      "stats",
    );
    expect(parsed).toEqual({
      channel: "stats",
      data: {
        agents: 1,
        transactions: 2,
        servicePurchases: 3,
        activeJobs: 4,
        volumeDrops: "5",
        tick: 6,
      },
    });
  });
  it("fails closed on garbage", () => {
    expect(parseSseEnvelope("not json")).toBeNull();
    expect(parseSseEnvelope(JSON.stringify({ channel: "event", data: { nope: true } }))).toBeNull();
    expect(
      parseSseEnvelope(JSON.stringify({ channel: "stats", data: { agents: "1" } })),
    ).toBeNull();
    expect(parseSseEnvelope(JSON.stringify({ channel: "unknown", data: {} }))).toBeNull();
  });
  it("accepts heartbeats", () => {
    expect(parseSseEnvelope(JSON.stringify({ channel: "heartbeat", data: { at: "x" } }))).toEqual({
      channel: "heartbeat",
      data: { at: "x" },
    });
  });
});
