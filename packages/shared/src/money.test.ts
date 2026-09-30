import { describe, expect, it } from "vitest";
import { compareMoney, dropsToXrp, formatMoney, isDropsString, xrp, xrpToDrops } from "./money";

describe("money", () => {
  it("converts XRP to drops and back without floating point drift", () => {
    expect(xrpToDrops("1")).toBe(1_000_000n);
    expect(xrpToDrops("0.001")).toBe(1_000n);
    expect(xrpToDrops(9.42)).toBe(9_420_000n);
    expect(dropsToXrp(9_420_000n)).toBe("9.42");
    expect(dropsToXrp("1")).toBe("0.000001");
    expect(dropsToXrp(0)).toBe("0");
  });

  it("rejects malformed drops strings", () => {
    expect(isDropsString("01")).toBe(false);
    expect(isDropsString("-1")).toBe(false);
    expect(isDropsString("1.5")).toBe(false);
    expect(isDropsString("1000")).toBe(true);
    expect(() => xrp("abc")).toThrow();
  });

  it("formats and compares", () => {
    expect(formatMoney(xrp(1_000))).toBe("0.001 XRP");
    expect(compareMoney(xrp(5), xrp(10))).toBe(-1);
    expect(compareMoney(xrp(10), xrp(10))).toBe(0);
  });
});
