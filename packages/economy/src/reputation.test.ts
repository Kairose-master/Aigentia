import { describe, expect, it } from "vitest";
import {
  REPUTATION_DELTAS,
  applyReputation,
  applyReputationDelta,
  clampReputation,
  isReputationEventKind,
  reputationKinds,
} from "./reputation";

describe("reputation", () => {
  it("uses the deltas fixed in ARCHITECTURE.md", () => {
    expect(REPUTATION_DELTAS).toEqual({
      SERVICE_SUCCESS_SELLER: 1,
      SERVICE_SUCCESS_BUYER: 0.25,
      SERVICE_FAILED_SELLER: -3,
      JOB_COMPLETED_WORKER: 2,
      JOB_COMPLETED_POSTER: 1,
      JOB_FAILED_WORKER: -3,
      PAYMENT_FAILED_BUYER: -1,
      PAYMENT_DENIED_BUYER: -0.5,
    });
    expect(reputationKinds).toHaveLength(8);
    expect(isReputationEventKind("JOB_FAILED_WORKER")).toBe(true);
    expect(isReputationEventKind("toString")).toBe(false);
    expect(isReputationEventKind(42)).toBe(false);
  });

  it("applies deltas and reports the effective change", () => {
    expect(applyReputation(50, "SERVICE_SUCCESS_SELLER")).toEqual({ next: 51, delta: 1 });
    expect(applyReputation(50, "SERVICE_FAILED_SELLER")).toEqual({ next: 47, delta: -3 });
    expect(applyReputation(50, "PAYMENT_DENIED_BUYER")).toEqual({ next: 49.5, delta: -0.5 });
  });

  it("clamps to 0..100 at both ends", () => {
    expect(applyReputation(99.5, "JOB_COMPLETED_WORKER")).toEqual({ next: 100, delta: 0.5 });
    expect(applyReputation(100, "SERVICE_SUCCESS_BUYER")).toEqual({ next: 100, delta: 0 });
    expect(applyReputation(1, "JOB_FAILED_WORKER")).toEqual({ next: 0, delta: -1 });
    expect(applyReputation(0, "PAYMENT_FAILED_BUYER")).toEqual({ next: 0, delta: 0 });
    expect(applyReputationDelta(150, -10)).toEqual({ next: 90, delta: -10 });
    expect(clampReputation(Number.NaN)).toBe(0);
    expect(clampReputation(-5)).toBe(0);
    expect(clampReputation(500)).toBe(100);
  });
});
