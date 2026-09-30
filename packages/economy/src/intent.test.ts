import { describe, expect, it } from "vitest";
import { isAigentiaError } from "@aigentia/shared";
import { RLUSD_CURRENCY_HEX } from "@aigentia/xrpl";
import { createPaymentIntent } from "./intent";
import { InMemorySpendTracker, spentInWindows, windows } from "./spend-tracker";

const DEST = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (e) {
    return isAigentiaError(e) ? e.code : "other";
  }
}

describe("createPaymentIntent", () => {
  it("fills id, createdAt and defaults, and validates", () => {
    const intent = createPaymentIntent({
      agentId: "agt_buyer00001",
      purpose: "transfer",
      destinationAddress: DEST,
      amount: 1_500n,
      actionRef: { kind: "decision", id: "dec_1" },
    });
    expect(intent.id).toMatch(/^pin_[0-9a-z]{16}$/);
    expect(intent.amount).toBe("1500");
    expect(intent.asset).toEqual({ code: "XRP" });
    expect(intent.destinationAgentId).toBeNull();
    expect(intent.serviceCategory).toBeNull();
    expect(intent.memo).toBeUndefined();
    expect(new Date(intent.createdAt).getTime()).not.toBeNaN();
  });

  it("accepts overrides for deterministic runs and issued currencies", () => {
    const intent = createPaymentIntent({
      id: "pin_fixed000001",
      createdAt: "2026-01-01T00:00:00.000Z",
      agentId: "agt_buyer00001",
      purpose: "x402",
      destinationAddress: DEST,
      destinationAgentId: "agt_seller0001",
      asset: { code: "RLUSD", issuer: DEST, currencyHex: RLUSD_CURRENCY_HEX },
      amount: "1.25",
      serviceCategory: "analysis",
      actionRef: { kind: "invocation", id: "inv_1" },
      memo: "hello",
    });
    expect(intent.id).toBe("pin_fixed000001");
    expect(intent.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(intent.amount).toBe("1.25");
    expect(intent.memo).toBe("hello");
  });

  it("rejects malformed input with VALIDATION_FAILED", () => {
    const base = {
      agentId: "agt_buyer00001",
      purpose: "transfer" as const,
      destinationAddress: DEST,
      amount: 10n,
      actionRef: { kind: "decision", id: "dec_1" },
    };
    expect(codeOf(() => createPaymentIntent({ ...base, amount: 0n }))).toBe("VALIDATION_FAILED");
    expect(codeOf(() => createPaymentIntent({ ...base, amount: "abc" }))).toBe("VALIDATION_FAILED");
    expect(codeOf(() => createPaymentIntent({ ...base, destinationAddress: "nope" }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(codeOf(() => createPaymentIntent({ ...base, agentId: "buyer" }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(
      codeOf(() =>
        createPaymentIntent({
          ...base,
          asset: { code: "RLUSD", issuer: DEST, currencyHex: RLUSD_CURRENCY_HEX },
          amount: "0",
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("InMemorySpendTracker", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");

  it("computes rolling windows", () => {
    const w = windows(now);
    expect(w.hourAgo.toISOString()).toBe("2026-05-01T11:00:00.000Z");
    expect(w.dayAgo.toISOString()).toBe("2026-04-30T12:00:00.000Z");
  });

  it("sums spend since a point in time, per agent", async () => {
    const tracker = new InMemorySpendTracker();
    await tracker.record("agt_a", 100n, new Date(now.getTime() - 30 * 60_000));
    await tracker.record("agt_a", 200n, new Date(now.getTime() - 5 * 3_600_000));
    await tracker.record("agt_a", 400n, new Date(now.getTime() - 30 * 3_600_000));
    await tracker.record("agt_b", 1_000n, now);
    const spent = await spentInWindows(tracker, "agt_a", now);
    expect(spent).toEqual({ spentLastHourDrops: 100n, spentLastDayDrops: 300n });
    expect(await tracker.spentSince("agt_b", windows(now).hourAgo)).toBe(1_000n);
    expect(await tracker.spentSince("agt_none", windows(now).dayAgo)).toBe(0n);

    tracker.prune(windows(now).dayAgo);
    expect(await tracker.spentSince("agt_a", new Date(0))).toBe(300n);
    tracker.clear();
    expect(await tracker.spentSince("agt_a", new Date(0))).toBe(0n);
  });
});
