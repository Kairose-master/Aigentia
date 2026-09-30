import {
  AigentiaError,
  DROPS_PER_XRP,
  SERVICE_CATEGORIES,
  isXrp,
  parseDrops,
  type Env,
} from "@aigentia/shared";
import {
  budgetPolicySchema,
  policyDecisionSchema,
  xrplAddressSchema,
  type BudgetPolicy,
  type PaymentIntent,
  type PolicyDecision,
} from "@aigentia/protocol";

/** Default fee headroom kept on top of the amount when checking balances (drops). */
export const DEFAULT_FEE_BUFFER_DROPS = 100n;

export type PolicyRule = PolicyDecision["violations"][number]["rule"];
export type PolicyViolation = PolicyDecision["violations"][number];

/** Everything the PolicyEngine needs to know about an agent at evaluation time. */
export interface PolicyContext {
  readonly policy: BudgetPolicy;
  /** Full ledger balance in drops (including the reserve). */
  readonly balanceDrops: bigint;
  /** XRPL reserve locked on the account (base + owner reserve). */
  readonly reserveDrops: bigint;
  readonly spentLastHourDrops: bigint;
  readonly spentLastDayDrops: bigint;
  /** The paying agent's own classic address. */
  readonly ownAddress: string;
  readonly now: Date;
  /** Fee headroom in drops; defaults to {@link DEFAULT_FEE_BUFFER_DROPS}. */
  readonly feeBufferDrops?: bigint;
}

/**
 * Drops-equivalent used for budget accounting. XRP intents are exact. Issued-currency intents
 * (e.g. RLUSD) are budgeted at unit parity — one unit counts as one XRP (1,000,000 drops) — so
 * the per-action / hourly / daily caps still bite while the ledger balance checks only charge
 * the XRP fee. Fractional units below one drop are rounded up.
 */
export function intentAmountDrops(intent: Pick<PaymentIntent, "asset" | "amount">): bigint {
  if (isXrp(intent.asset)) return parseDrops(intent.amount);
  const [whole = "0", frac = ""] = intent.amount.split(".");
  const scaledFrac = frac.slice(0, 6).padEnd(6, "0");
  const remainder = frac.slice(6).replace(/0+$/, "");
  const scaled = BigInt(whole) * DROPS_PER_XRP + BigInt(scaledFrac);
  return remainder.length > 0 ? scaled + 1n : scaled;
}

function violation(
  rule: PolicyRule,
  message: string,
  extra: { limitDrops?: bigint; attemptedDrops?: bigint } = {},
): PolicyViolation {
  return {
    rule,
    message,
    ...(extra.limitDrops !== undefined ? { limitDrops: extra.limitDrops.toString() } : {}),
    ...(extra.attemptedDrops !== undefined
      ? { attemptedDrops: extra.attemptedDrops.toString() }
      : {}),
  };
}

/**
 * Economic safety envelope. Every rule is evaluated and every violation is reported so the
 * decision trace explains the whole picture; `approved` is true only with zero violations.
 * Pure and synchronous: callers gather balances and spend windows first.
 */
export class PolicyEngine {
  evaluate(intent: PaymentIntent, ctx: PolicyContext): PolicyDecision {
    const { policy } = ctx;
    const fee = ctx.feeBufferDrops ?? DEFAULT_FEE_BUFFER_DROPS;
    const amount = intentAmountDrops(intent);
    /** Only XRP leaves the XRP balance; issued currencies cost the fee alone. */
    const xrpOutflow = isXrp(intent.asset) ? amount : 0n;
    const violations: PolicyViolation[] = [];

    const perAction = parseDrops(policy.maxSpendPerActionDrops);
    if (amount > perAction) {
      violations.push(
        violation(
          "MAX_SPEND_PER_ACTION",
          `amount ${amount} drops exceeds the per-action limit of ${perAction} drops`,
          { limitDrops: perAction, attemptedDrops: amount },
        ),
      );
    }

    const perHour = parseDrops(policy.maxSpendPerHourDrops);
    const hourTotal = ctx.spentLastHourDrops + amount;
    if (hourTotal > perHour) {
      violations.push(
        violation(
          "MAX_SPEND_PER_HOUR",
          `spending ${amount} drops would bring the last hour to ${hourTotal} drops, above the limit of ${perHour} drops`,
          { limitDrops: perHour, attemptedDrops: hourTotal },
        ),
      );
    }

    const perDay = parseDrops(policy.maxDailySpendDrops);
    const dayTotal = ctx.spentLastDayDrops + amount;
    if (dayTotal > perDay) {
      violations.push(
        violation(
          "MAX_DAILY_SPEND",
          `spending ${amount} drops would bring the last 24h to ${dayTotal} drops, above the limit of ${perDay} drops`,
          { limitDrops: perDay, attemptedDrops: dayTotal },
        ),
      );
    }

    if (!policy.allowedAssets.includes(intent.asset.code)) {
      violations.push(
        violation(
          "ASSET_NOT_ALLOWED",
          `asset ${intent.asset.code} is not in the allowed assets [${policy.allowedAssets.join(", ")}]`,
        ),
      );
    }

    if (
      intent.serviceCategory !== null &&
      !policy.allowedServiceCategories.includes(intent.serviceCategory)
    ) {
      violations.push(
        violation(
          "CATEGORY_NOT_ALLOWED",
          `service category ${intent.serviceCategory} is not in the allowed categories [${policy.allowedServiceCategories.join(", ")}]`,
        ),
      );
    }

    const minimumBalance = parseDrops(policy.minimumBalanceDrops);
    const floor = minimumBalance + ctx.reserveDrops;
    const remaining = ctx.balanceDrops - xrpOutflow - fee;
    if (remaining < floor) {
      violations.push(
        violation(
          "MINIMUM_BALANCE",
          `balance after payment would be ${remaining} drops, below the minimum balance ${minimumBalance} drops plus reserve ${ctx.reserveDrops} drops`,
          { limitDrops: floor, attemptedDrops: xrpOutflow + fee },
        ),
      );
    }

    const spendable = ctx.balanceDrops - ctx.reserveDrops;
    if (spendable < xrpOutflow + fee) {
      violations.push(
        violation(
          "INSUFFICIENT_FUNDS",
          `spendable balance ${spendable < 0n ? 0n : spendable} drops cannot cover ${xrpOutflow} drops plus a ${fee} drop fee`,
          { limitDrops: spendable < 0n ? 0n : spendable, attemptedDrops: xrpOutflow + fee },
        ),
      );
    }

    if (
      intent.destinationAddress === ctx.ownAddress ||
      (intent.destinationAgentId !== null && intent.destinationAgentId === intent.agentId)
    ) {
      violations.push(violation("SELF_PAYMENT", "an agent cannot pay itself"));
    }

    if (!xrplAddressSchema.safeParse(intent.destinationAddress).success) {
      violations.push(
        violation(
          "INVALID_DESTINATION",
          `destination ${intent.destinationAddress} is not a valid XRPL classic address`,
        ),
      );
    }

    return policyDecisionSchema.parse({
      approved: violations.length === 0,
      violations,
      evaluatedAt: ctx.now.toISOString(),
      snapshot: {
        balanceDrops: ctx.balanceDrops.toString(),
        spentLastHourDrops: ctx.spentLastHourDrops.toString(),
        spentLastDayDrops: ctx.spentLastDayDrops.toString(),
      },
    });
  }
}

/** Build the POLICY_DENIED error a Settlement layer throws for a denied decision. */
export function policyDeniedError(
  intent: Pick<PaymentIntent, "id" | "agentId">,
  decision: PolicyDecision,
): AigentiaError {
  const rules = decision.violations.map((v) => v.rule);
  return new AigentiaError("POLICY_DENIED", `payment denied by policy: ${rules.join(", ")}`, {
    intentId: intent.id,
    agentId: intent.agentId,
    violations: decision.violations,
  });
}

/** Throws POLICY_DENIED unless the decision is approved. */
export function assertApproved(
  intent: Pick<PaymentIntent, "id" | "agentId">,
  decision: PolicyDecision,
): void {
  if (!decision.approved) throw policyDeniedError(intent, decision);
}

export type PolicyEnv = Pick<
  Env,
  | "POLICY_MAX_SPEND_PER_ACTION_DROPS"
  | "POLICY_MAX_SPEND_PER_HOUR_DROPS"
  | "POLICY_MAX_DAILY_SPEND_DROPS"
  | "POLICY_MINIMUM_BALANCE_DROPS"
>;

/** Budget policy for new agents, from the POLICY_* environment variables. */
export function defaultBudgetPolicy(env: PolicyEnv): BudgetPolicy {
  return budgetPolicySchema.parse({
    maxSpendPerActionDrops: env.POLICY_MAX_SPEND_PER_ACTION_DROPS,
    maxSpendPerHourDrops: env.POLICY_MAX_SPEND_PER_HOUR_DROPS,
    maxDailySpendDrops: env.POLICY_MAX_DAILY_SPEND_DROPS,
    minimumBalanceDrops: env.POLICY_MINIMUM_BALANCE_DROPS,
    allowedAssets: ["XRP"],
    allowedServiceCategories: [...SERVICE_CATEGORIES],
  });
}

/** Overlay a partial policy (e.g. an experiment override) on a base policy; validated. */
export function mergeBudgetPolicy(
  base: BudgetPolicy,
  partial: Partial<BudgetPolicy>,
): BudgetPolicy {
  const defined = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  ) as Partial<BudgetPolicy>;
  const parsed = budgetPolicySchema.safeParse({ ...base, ...defined });
  if (!parsed.success) {
    throw new AigentiaError("VALIDATION_FAILED", "invalid budget policy", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

export interface BudgetHeadroom {
  readonly remainingHourDrops: bigint;
  readonly remainingDayDrops: bigint;
  /** Largest single payment the caps alone would still allow (never negative). */
  readonly maxNextActionDrops: bigint;
}

/** How much the spend caps still allow, for observations and pre-checks. */
export function budgetHeadroom(
  policy: BudgetPolicy,
  spent: { spentLastHourDrops: bigint; spentLastDayDrops: bigint },
): BudgetHeadroom {
  const clamp = (v: bigint): bigint => (v < 0n ? 0n : v);
  const remainingHourDrops = clamp(
    parseDrops(policy.maxSpendPerHourDrops) - spent.spentLastHourDrops,
  );
  const remainingDayDrops = clamp(parseDrops(policy.maxDailySpendDrops) - spent.spentLastDayDrops);
  const perAction = parseDrops(policy.maxSpendPerActionDrops);
  const maxNextActionDrops = [perAction, remainingHourDrops, remainingDayDrops].reduce((a, b) =>
    a < b ? a : b,
  );
  return { remainingHourDrops, remainingDayDrops, maxNextActionDrops };
}
