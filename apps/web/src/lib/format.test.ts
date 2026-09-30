import { describe, expect, it } from "vitest";
import {
  compareDropsDesc,
  formatCountdown,
  formatXrp,
  formatXrpCompact,
  parseDropsSafe,
  resolveTxLink,
  shortAddress,
  shortHash,
  sumDrops,
  timeAgo,
  explorerAccountUrl,
  explorerTxUrl,
} from "./format";

describe("formatXrp", () => {
  it("formats whole and fractional drops without floating point", () => {
    expect(formatXrp("1000000")).toBe("1");
    expect(formatXrp("1500000")).toBe("1.5");
    expect(formatXrp("1")).toBe("0.000001");
    expect(formatXrp("123456789012")).toBe("123,456.789012");
    expect(formatXrp(0n)).toBe("0");
  });
  it("respects fraction bounds and unit", () => {
    expect(formatXrp("1234567", { maxFraction: 2 })).toBe("1.23");
    expect(formatXrp("1000000", { minFraction: 2 })).toBe("1.00");
    expect(formatXrp("2000000", { unit: true })).toBe("2 XRP");
    expect(formatXrp("2000000", { signed: true })).toBe("+2");
    expect(formatXrp("-2500000")).toBe("-2.5");
  });
  it("degrades on malformed input", () => {
    expect(formatXrp("abc")).toBe("—");
    expect(formatXrp(null)).toBe("—");
    expect(formatXrp(undefined)).toBe("—");
    expect(parseDropsSafe("1.5")).toBeNull();
    expect(parseDropsSafe(1.5)).toBeNull();
  });
  it("compacts large amounts for hero tiles", () => {
    expect(formatXrpCompact("1500000000000")).toBe("1.50M");
    expect(formatXrpCompact("42500000000")).toBe("42.5K");
    expect(formatXrpCompact("1250000")).toBe("1.25");
    expect(formatXrpCompact("0")).toBe("0");
    expect(formatXrpCompact("nope")).toBe("—");
  });
  it("sums and compares drops as bigint", () => {
    expect(sumDrops(["1", "2", null, "bad", 3n])).toBe(6n);
    expect(["1", "30", "2"].sort(compareDropsDesc)).toEqual(["30", "2", "1"]);
  });
});

describe("addresses, hashes and time", () => {
  it("shortens addresses and hashes", () => {
    expect(shortAddress("rQ4x1234567890abcdefghijk8kLm")).toBe("rQ4x12…8kLm");
    expect(shortAddress("short")).toBe("short");
    expect(shortAddress(null)).toBe("—");
    expect(shortHash("3f1a".padEnd(64, "0"))).toBe("3F1A00…0000");
  });
  it("renders relative time", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(timeAgo("2026-09-30T11:59:58Z", now)).toBe("just now");
    expect(timeAgo("2026-09-30T11:59:10Z", now)).toBe("50s ago");
    expect(timeAgo("2026-09-30T11:30:00Z", now)).toBe("30m ago");
    expect(timeAgo("2026-09-30T05:00:00Z", now)).toBe("7h ago");
    expect(timeAgo("2026-09-27T12:00:00Z", now)).toBe("3d ago");
    expect(timeAgo("2026-09-30T12:05:00Z", now)).toBe("in 5m");
    expect(timeAgo("not-a-date", now)).toBe("—");
  });
  it("formats countdowns", () => {
    expect(formatCountdown(0)).toBe("00:00:00");
    expect(formatCountdown(-5)).toBe("00:00:00");
    expect(formatCountdown(3_723_000)).toBe("01:02:03");
    expect(formatCountdown(90_000_000)).toBe("1d 01:00:00");
  });
});

describe("explorer links", () => {
  it("builds testnet explorer links", () => {
    expect(explorerTxUrl("ABC")).toBe("https://testnet.xrpl.org/transactions/ABC");
    expect(explorerAccountUrl("rABC")).toBe("https://testnet.xrpl.org/accounts/rABC");
  });
  it("never links mock-ledger items", () => {
    expect(resolveTxLink({ txHash: "ABC", ledger: "mock" })).toEqual({ href: null, mock: true });
    expect(resolveTxLink({ txHash: "ABC", ledger: "testnet" })).toEqual({
      href: "https://testnet.xrpl.org/transactions/ABC",
      mock: false,
    });
    expect(resolveTxLink({ txHash: "ABC", ledger: "testnet", explorerUrl: "https://x/y" })).toEqual(
      { href: "https://x/y", mock: false },
    );
    expect(resolveTxLink({ txHash: "ABC", explorerUrl: null })).toEqual({ href: null, mock: true });
    expect(resolveTxLink({ txHash: null })).toEqual({ href: null, mock: false });
  });
});
