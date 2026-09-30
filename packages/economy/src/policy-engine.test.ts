import { describe, expect, it } from "vitest";
import { RLUSD_CURRENCY_HEX } from "@aigentia/xrpl";
import { budgetPolicySchema, type BudgetPolicy, type PaymentIntent } from "@aigentia/protocol";
import { createPaymentIntent } from "./intent";
import {
  PolicyEngine,
  assertApproved,
  budgetHeadroom,
  defaultBudgetPolicy,
  intentAmountDrops,
  mergeBudgetPolicy,
  type PolicyContext,
  type PolicyRule,
} from "./policy-engine";

const OWN = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const OTHER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const NOW = new Date("2026-05-01T12:00:00.000Z");

const policy: BudgetPolicy = budgetPolicySchema.parse({
  maxSpendPerActionDrops: "500000",
  maxSpendPerHourDrops: "3000000",
  maxDailySpendDrops: "8000000",
  minimumBalanceDrops: "1500000",
});

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    ...createPaymentIntent({
      id: "pin_test000001",
      agentId: "agt_buyer00001",
      purpose: "x402",
      destinationAddress: OTHER,
      destinationAgentId: "agt_seller0001",
      amount: 100_000n,
      serviceCategory: "intelligence",
      actionRef: { kind: "invocation", id: "inv_000001" },
      createdAt: NOW.toISOString(),
    }),
    ...overrides,
  };
}

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    policy,
    balanceDrops: 10_000_000n,
    reserveDrops: 1_000_000n,
    spentLastHourDrops: 0n,
    spentLastDayDrops: 0n,
    ownAddress: OWN,
    now: NOW,
    ...overrides,
  };
}

const engine = new PolicyEngine();
const rules = (i: PaymentIntent, c: PolicyContext): PolicyRule[] =>
  engine.evaluate(i, c).violations.map((v) => v.rule);

describe("PolicyEngine", () => {
  it("approves a payment inside every limit", () => {
    const decision = engine.evaluate(intent(), ctx());
    expect(decision.approved).toBe(true);
    expect(decision.violations).toEqual([]);
    expect(decision.evaluatedAt).toBe(NOW.toISOString());
    expect(decision.snapshot).toEqual({
      balanceDrops: "10000000",
      spentLastHourDrops: "0",
      spentLastDayDrops: "0",
    });
    expect(() => assertApproved(intent(), decision)).not.toThrow();
  });

  it("denies overspend per action", () => {
    const decision = engine.evaluate(intent({ amount: "600000" }), ctx());
    expect(decision.approved).toBe(false);
    expect(decision.violations).toHaveLength(1);
    expect(decision.violations[0]).toMatchObject({
      rule: "MAX_SPEND_PER_ACTION",
      limitDrops: "500000",
      attemptedDrops: "600000",
    });
    expect(() => assertApproved(intent(), decision)).toThrow(/POLICY_DENIED|denied/);
  });

  it("denies overspend per hour (spent so far + amount)", () => {
    const r = rules(
      intent({ amount: "400000" }),
      ctx({ spentLastHourDrops: 2_700_000n, spentLastDayDrops: 2_700_000n }),
    );
    expect(r).toEqual(["MAX_SPEND_PER_HOUR"]);
  });

  it("denies overspend per day", () => {
    const decision = engine.evaluate(
      intent({ amount: "400000" }),
      ctx({ spentLastHourDrops: 0n, spentLastDayDrops: 7_800_000n }),
    );
    expect(decision.violations.map((v) => v.rule)).toEqual(["MAX_DAILY_SPEND"]);
    expect(decision.violations[0]?.attemptedDrops).toBe("8200000");
  });

  it("denies a payment that would dip below the minimum balance plus reserve", () => {
    const r = rules(
      intent({ amount: "200000" }),
      ctx({ balanceDrops: 2_600_000n, reserveDrops: 1_000_000n }),
    );
    expect(r).toEqual(["MINIMUM_BALANCE"]);
  });

  it("reports insufficient funds together with the minimum-balance breach", () => {
    const r = rules(
      intent({ amount: "200000" }),
      ctx({ balanceDrops: 1_100_000n, reserveDrops: 1_000_000n }),
    );
    expect(r).toEqual(["MINIMUM_BALANCE", "INSUFFICIENT_FUNDS"]);
  });

  it("accounts for the fee buffer", () => {
    // balance − amount − fee must stay ≥ minimum + reserve: 2_600_100 − 100_000 − 100 = 2_500_000.
    const exact = ctx({ balanceDrops: 2_600_100n, reserveDrops: 1_000_000n });
    expect(rules(intent(), exact)).toEqual([]);
    expect(rules(intent(), { ...exact, balanceDrops: 2_600_099n })).toEqual(["MINIMUM_BALANCE"]);
    expect(rules(intent(), { ...exact, balanceDrops: 2_600_099n, feeBufferDrops: 0n })).toEqual([]);
  });

  it("reports every violation together", () => {
    const r = rules(
      intent({ amount: "600000", destinationAddress: OWN }),
      ctx({ spentLastHourDrops: 2_700_000n, spentLastDayDrops: 7_800_000n }),
    );
    expect(r).toEqual([
      "MAX_SPEND_PER_ACTION",
      "MAX_SPEND_PER_HOUR",
      "MAX_DAILY_SPEND",
      "SELF_PAYMENT",
    ]);
  });

  it("gates service categories only when the intent names one", () => {
    const narrow = mergeBudgetPolicy(policy, { allowedServiceCategories: ["intelligence"] });
    expect(rules(intent({ serviceCategory: "logistics" }), ctx({ policy: narrow }))).toEqual([
      "CATEGORY_NOT_ALLOWED",
    ]);
    expect(rules(intent({ serviceCategory: "intelligence" }), ctx({ policy: narrow }))).toEqual([]);
    expect(rules(intent({ serviceCategory: null }), ctx({ policy: narrow }))).toEqual([]);
  });

  it("gates assets and budgets issued currencies at unit parity", () => {
    const rlusd = intent({
      asset: { code: "RLUSD", issuer: OTHER, currencyHex: RLUSD_CURRENCY_HEX },
      amount: "0.25",
    });
    expect(intentAmountDrops(rlusd)).toBe(250_000n);
    expect(intentAmountDrops({ asset: rlusd.asset, amount: "1.0000001" })).toBe(1_000_001n);
    expect(rules(rlusd, ctx())).toEqual(["ASSET_NOT_ALLOWED"]);

    const wide = mergeBudgetPolicy(policy, { allowedAssets: ["XRP", "RLUSD"] });
    expect(rules(rlusd, ctx({ policy: wide }))).toEqual([]);
    // Issued value counts toward the caps but only the fee touches the XRP balance.
    expect(rules({ ...rlusd, amount: "0.6" }, ctx({ policy: wide }))).toEqual([
      "MAX_SPEND_PER_ACTION",
    ]);
    expect(rules(rlusd, ctx({ policy: wide, balanceDrops: 2_500_100n }))).toEqual([]);
  });

  it("denies self payment by address or by agent id", () => {
    expect(rules(intent({ destinationAddress: OWN }), ctx())).toEqual(["SELF_PAYMENT"]);
    expect(rules(intent({ destinationAgentId: "agt_buyer00001" }), ctx())).toEqual([
      "SELF_PAYMENT",
    ]);
  });

  it("denies invalid destinations", () => {
    expect(rules(intent({ destinationAddress: "not-an-address" }), ctx())).toEqual([
      "INVALID_DESTINATION",
    ]);
    expect(rules(intent({ destinationAddress: "0xabc" }), ctx())).toEqual(["INVALID_DESTINATION"]);
  });

  it("never approves with a violation present", () => {
    const scenarios: Array<[PaymentIntent, PolicyContext]> = [
      [intent({ amount: "500001" }), ctx()],
      [intent(), ctx({ balanceDrops: 0n })],
      [intent(), ctx({ spentLastDayDrops: 8_000_000n })],
    ];
    for (const [i, c] of scenarios) {
      const d = engine.evaluate(i, c);
      expect(d.approved).toBe(d.violations.length === 0);
      expect(d.approved).toBe(false);
    }
  });
});

describe("budget policy helpers", () => {
  it("builds the default policy from POLICY_* env vars", () => {
    const p = defaultBudgetPolicy({
      POLICY_MAX_SPEND_PER_ACTION_DROPS: "500000",
      POLICY_MAX_SPEND_PER_HOUR_DROPS: "3000000",
      POLICY_MAX_DAILY_SPEND_DROPS: "8000000",
      POLICY_MINIMUM_BALANCE_DROPS: "1500000",
    });
    expect(p).toEqual({
      maxSpendPerActionDrops: "500000",
      maxSpendPerHourDrops: "3000000",
      maxDailySpendDrops: "8000000",
      minimumBalanceDrops: "1500000",
      allowedAssets: ["XRP"],
      allowedServiceCategories: ["intelligence", "analysis", "logistics"],
    });
  });

  it("merges partial overrides and rejects invalid values", () => {
    const merged = mergeBudgetPolicy(policy, {
      maxSpendPerActionDrops: "1",
      allowedAssets: undefined,
    });
    expect(merged.maxSpendPerActionDrops).toBe("1");
    expect(merged.allowedAssets).toEqual(["XRP"]);
    expect(() => mergeBudgetPolicy(policy, { maxDailySpendDrops: "-5" })).toThrow(
      /invalid budget policy/,
    );
    expect(() => mergeBudgetPolicy(policy, { allowedAssets: [] })).toThrow(/invalid budget policy/);
  });

  it("computes remaining headroom, never negative", () => {
    expect(
      budgetHeadroom(policy, { spentLastHourDrops: 2_800_000n, spentLastDayDrops: 9_000_000n }),
    ).toEqual({ remainingHourDrops: 200_000n, remainingDayDrops: 0n, maxNextActionDrops: 0n });
    expect(budgetHeadroom(policy, { spentLastHourDrops: 0n, spentLastDayDrops: 0n })).toEqual({
      remainingHourDrops: 3_000_000n,
      remainingDayDrops: 8_000_000n,
      maxNextActionDrops: 500_000n,
    });
  });
});
