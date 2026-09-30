import { SERVICE_KIND_CATEGORY, SeededRandom, deriveSeed } from "@aigentia/shared";
import type { Objective, ResourceType, ServiceKind } from "@aigentia/shared";
import type {
  AgentAction,
  Decision,
  Observation,
  ObservedJob,
  ObservedService,
} from "@aigentia/protocol";
import { runDecide } from "./brain";
import type {
  AgentBrain,
  Candidate,
  DecisionResult,
  ExecutionOutcome,
  ObservationView,
  Plan,
} from "./brain";
import { memoryToRecord, parseMemory, updateMemory } from "./memory";
import type { AgentMemory } from "./memory";
import { compactObservation } from "./observation-summary";

/**
 * Reproducible rule-based brain. All randomness flows through
 * `SeededRandom(deriveSeed(worldSeed, agentId, tick))` and is used only to break ties
 * between candidates of equal expected value and risk.
 */
export interface DeterministicAgentOptions {
  worldSeed: string;
}

/** Tunables (drops unless stated). Kept in one place so strategies are easy to audit. */
const TUNING = {
  scoutIntelValueCap: 300_000n,
  analystIntelValueCap: 250_000n,
  intelValueShareDivisor: 10n,
  minJobRewardNetWorth: 10_000n,
  minCounterpartySuccessRate: 0.5,
  minCounterpartyReputation: 20,
  maxClaimedJobs: 2,
  maxOpenPostedJobs: 2,
  tipIntervalTicks: 10,
  jobPostIntervalTicks: 10,
  relistIntervalTicks: 8,
  maxHeldUnits: 30,
  tipCap: 50_000n,
  minTip: 1_000n,
  minJobReward: 10_000n,
  jobRewardCap: 200_000n,
  jobExpiryTicks: 30,
  reputationBonusDrops: 50_000n,
  knowledgeFreshTicks: 20,
  cheapAskPercent: 90n,
  strongBidPercent: 100n,
  costBasisMarginPercent: 105n,
  maxResourceQuantity: 10,
  defaultPrices: {
    SCOUT: 5_000n,
    ANALYST: 60_000n,
    COURIER: 20_000n,
  } as Record<ServiceKind, bigint>,
  cheapPrices: { SCOUT: 3_000n, ANALYST: 5_000n, COURIER: 5_000n } as Record<ServiceKind, bigint>,
  brokerMarkupPercent: 150n,
  brokerMinPrice: 10_000n,
  premiumAnalystPrice: 150_000n,
} as const;

interface PlanMeta {
  objective: Objective;
  capDrops: bigint;
  agentName: string;
}

interface Ctx {
  view: ObservationView;
  mem: AgentMemory;
  me: string;
  tick: number;
  cap: bigint;
  spendable: bigint;
  rng: SeededRandom;
}

function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a));
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function pct(value: bigint, percent: bigint): bigint {
  return (value * percent) / 100n;
}

/** Hard ceiling for any single spend this tick, derived from the observation's budget. */
export function spendCapDrops(obs: Observation): bigint {
  const b = obs.budget;
  const cap = min(
    BigInt(b.maxSpendPerActionDrops),
    BigInt(b.remainingHourDrops),
    BigInt(b.remainingDayDrops),
    BigInt(obs.spendableDrops) - BigInt(b.minimumBalanceDrops),
  );
  return cap > 0n ? cap : 0n;
}

function categoryAllowed(view: ObservationView, kind: ServiceKind): boolean {
  return view.budget.allowedServiceCategories.includes(SERVICE_KIND_CATEGORY[kind]);
}

function hasFreshKnowledge(ctx: Ctx, resourceType?: ResourceType): boolean {
  return ctx.view.knowledge.some(
    (k) =>
      (resourceType === undefined || k.resourceType === resourceType) &&
      ctx.tick - k.learnedAtTick <= TUNING.knowledgeFreshTicks,
  );
}

function claimedJobs(ctx: Ctx): ObservedJob[] {
  return ctx.view.myJobs.filter(
    (j) => j.status === "claimed" && j.claimedByAgentId === ctx.me && j.posterAgentId !== ctx.me,
  );
}

function requirementOf(job: ObservedJob): {
  kind?: string;
  resourceType?: ResourceType;
  quantity?: number;
  locationId?: string;
} {
  const r = job.requirement ?? {};
  const kind = typeof r.kind === "string" ? r.kind : undefined;
  const resourceType = typeof r.resourceType === "string" ? r.resourceType : undefined;
  const quantity = typeof r.quantity === "number" ? r.quantity : undefined;
  const locationId = typeof r.locationId === "string" ? r.locationId : undefined;
  return {
    kind,
    resourceType: resourceType as ResourceType | undefined,
    quantity,
    locationId,
  };
}

/** Can this agent plausibly fulfil the job's requirement with what it has right now? */
function canFulfil(ctx: Ctx, job: ObservedJob): boolean {
  const req = requirementOf(job);
  if (req.kind === undefined) return true;
  if (req.kind === "analysis") return true;
  if (req.kind === "deliver_resource") {
    if (req.resourceType === undefined) return false;
    const held = ctx.view.inventory
      .filter((i) => i.resourceType === req.resourceType)
      .reduce((s, i) => s + i.quantity, 0);
    return held >= (req.quantity ?? 1);
  }
  if (req.kind === "report_resource_location") {
    return ctx.view.knowledge.some(
      (k) => req.resourceType === undefined || k.resourceType === req.resourceType,
    );
  }
  return false;
}

function submissionFor(ctx: Ctx, job: ObservedJob): Record<string, unknown> {
  const req = requirementOf(job);
  if (req.kind === "deliver_resource" && req.resourceType !== undefined) {
    return {
      resourceType: req.resourceType,
      quantity: req.quantity ?? 1,
      ...(req.locationId !== undefined ? { locationId: req.locationId } : {}),
    };
  }
  if (req.kind === "report_resource_location") {
    const known = [...ctx.view.knowledge]
      .filter((k) => req.resourceType === undefined || k.resourceType === req.resourceType)
      .sort((a, b) => b.learnedAtTick - a.learnedAtTick)[0];
    if (known) {
      return {
        resourceType: known.resourceType,
        locationId: known.locationId,
        quantity: known.quantity,
        learnedAtTick: known.learnedAtTick,
      };
    }
  }
  if (req.kind === "analysis") {
    const reports = Object.entries(ctx.view.marketPrices)
      .filter(([type]) => req.resourceType === undefined || type === req.resourceType)
      .map(([resourceType, p]) => {
        const ema = ctx.mem.askEmaDrops[resourceType];
        const ask = BigInt(p.askDrops);
        const trend =
          ema === undefined
            ? "flat"
            : ask > BigInt(ema)
              ? "rising"
              : ask < BigInt(ema)
                ? "falling"
                : "flat";
        return { resourceType, bidDrops: p.bidDrops, askDrops: p.askDrops, trend };
      });
    return { analysis: reports, tick: ctx.tick };
  }
  return { note: "Completed as requested.", tick: ctx.tick };
}

// ── candidate generators ───────────────────────────────────────────────────────

function submitCandidates(ctx: Ctx, bonus = 0n): Candidate[] {
  return claimedJobs(ctx)
    .filter((job) => canFulfil(ctx, job))
    .map((job) => ({
      action: { type: "SUBMIT_JOB", jobId: job.id, submission: submissionFor(ctx, job) },
      expectedValueDrops: BigInt(job.rewardDrops) + bonus,
      risk: 0.1,
      note: `Submitting work for job "${job.title}" posted by ${job.posterName}.`,
    }));
}

function acceptCandidates(ctx: Ctx, minReward: bigint, bonus = 0n): Candidate[] {
  if (claimedJobs(ctx).length >= TUNING.maxClaimedJobs) return [];
  return ctx.view.availableJobs
    .filter(
      (job) =>
        job.status === "open" &&
        job.posterAgentId !== ctx.me &&
        job.claimedByAgentId === null &&
        job.expiresAtTick > ctx.tick &&
        BigInt(job.rewardDrops) >= minReward &&
        canFulfil(ctx, job),
    )
    .map((job) => ({
      action: { type: "ACCEPT_JOB", jobId: job.id },
      expectedValueDrops: pct(BigInt(job.rewardDrops), 80n) + bonus,
      risk: 0.2,
      note: `Accepting job "${job.title}" from ${job.posterName}.`,
    }));
}

interface IntelOptions {
  kinds: readonly ServiceKind[];
  /** Max share of spendable balance to put into one purchase, in percent. */
  sharePercent: bigint;
  minGapTicks: number;
  /** Multiplier applied to the base intel value (information-hungry objectives). */
  valuePercent?: bigint;
  /** Skip when knowledge is already fresh. */
  skipIfFresh?: boolean;
}

function preferredResource(ctx: Ctx): ResourceType | undefined {
  const entries = Object.entries(ctx.view.marketPrices) as [ResourceType, { askDrops: string }][];
  const sorted = entries.sort((a, b) => {
    const x = BigInt(a[1].askDrops);
    const y = BigInt(b[1].askDrops);
    return x === y ? 0 : x > y ? -1 : 1;
  });
  return sorted[0]?.[0];
}

function reputableSeller(s: ObservedService): boolean {
  return (
    s.totalCalls === 0 ||
    (s.successRate >= TUNING.minCounterpartySuccessRate &&
      s.reputation >= TUNING.minCounterpartyReputation)
  );
}

function buyIntelCandidates(ctx: Ctx, opts: IntelOptions): Candidate[] {
  if (ctx.cap <= 0n) return [];
  if (ctx.mem.ticksSinceLastPurchase < opts.minGapTicks) return [];
  if (opts.skipIfFresh && hasFreshKnowledge(ctx)) return [];
  const budget = min(ctx.cap, pct(ctx.spendable, opts.sharePercent));
  const resource = preferredResource(ctx);
  const out: Candidate[] = [];
  for (const s of ctx.view.availableServices) {
    if (!opts.kinds.includes(s.kind)) continue;
    if (s.sellerAgentId === ctx.me) continue;
    if (!categoryAllowed(ctx.view, s.kind)) continue;
    if (ctx.mem.failedServiceIds.includes(s.id)) continue;
    if (!reputableSeller(s)) continue;
    const price = BigInt(s.priceDrops);
    if (price <= 0n || price > budget) continue;
    const baseValue =
      s.kind === "SCOUT"
        ? min(ctx.spendable / TUNING.intelValueShareDivisor, TUNING.scoutIntelValueCap)
        : s.kind === "ANALYST"
          ? min(ctx.spendable / TUNING.intelValueShareDivisor, TUNING.analystIntelValueCap)
          : 0n;
    if (baseValue === 0n) continue;
    const quality = BigInt(Math.round(s.successRate * 100)) * BigInt(Math.round(s.reputation));
    const value = (pct(baseValue, opts.valuePercent ?? 100n) * max(quality, 1n)) / 10_000n;
    const ev = value - price;
    if (ev <= 0n) continue;
    const input =
      s.kind === "SCOUT"
        ? resource !== undefined
          ? { resourceType: resource }
          : {}
        : { ...(resource !== undefined ? { resourceType: resource } : {}), horizonTicks: 10 };
    out.push({
      action: { type: "BUY_SERVICE", serviceId: s.id, input, maxPriceDrops: price.toString() },
      expectedValueDrops: ev,
      risk: Math.min(1, Math.max(0, 1 - s.successRate * (s.reputation / 100))),
      note: `Buying ${s.kind} service from ${s.sellerName}.`,
    });
  }
  return out;
}

function offerCandidate(
  ctx: Ctx,
  kind: ServiceKind,
  price: bigint,
  expectedCalls: bigint,
  noteWhenNew: string,
): Candidate | undefined {
  if (price <= 0n) return undefined;
  const existing = ctx.view.myServices.find((s) => s.kind === kind);
  if (existing && BigInt(existing.priceDrops) === price) return undefined;
  const lastListing = ctx.mem.lastListingTick;
  if (existing && lastListing !== null && ctx.tick - lastListing < TUNING.relistIntervalTicks)
    return undefined;
  const ev = existing ? price / 2n : price * expectedCalls;
  return {
    action: { type: "SELL_SERVICE", kind, priceDrops: price.toString() },
    expectedValueDrops: ev,
    risk: existing ? 0.05 : 0.15,
    note: existing
      ? `Re-pricing my ${kind} service to ${price} drops.`
      : `${noteWhenNew} at ${price} drops.`,
  };
}

function targetPrice(ctx: Ctx, kind: ServiceKind, fallback: bigint): bigint {
  const remembered = ctx.mem.priceDrops[kind];
  return remembered === undefined ? fallback : BigInt(remembered);
}

function sellResourceCandidates(ctx: Ctx): Candidate[] {
  const out: Candidate[] = [];
  const byType = new Map<ResourceType, number>();
  for (const item of ctx.view.inventory) {
    if (item.quantity <= 0) continue;
    byType.set(item.resourceType, (byType.get(item.resourceType) ?? 0) + item.quantity);
  }
  for (const [resourceType, quantity] of byType) {
    const price = ctx.view.marketPrices[resourceType];
    if (!price) continue;
    const bid = BigInt(price.bidDrops);
    if (bid <= 0n) continue;
    const basis = ctx.mem.costBasisDrops[resourceType];
    const ema = ctx.mem.askEmaDrops[resourceType];
    let threshold: bigint;
    if (basis !== undefined) threshold = pct(BigInt(basis), TUNING.costBasisMarginPercent);
    else if (ema !== undefined) threshold = pct(BigInt(ema), TUNING.strongBidPercent);
    else continue;
    if (bid < threshold) continue;
    const qty = Math.min(quantity, 1000);
    out.push({
      action: {
        type: "SELL_RESOURCE",
        resourceType,
        quantity: qty,
        unitPriceDrops: bid.toString(),
        toMarket: true,
      },
      expectedValueDrops: (bid - (basis !== undefined ? BigInt(basis) : 0n)) * BigInt(qty),
      risk: 0.1,
      note: `Selling ${qty} ${resourceType} to the market at ${bid} drops each.`,
    });
  }
  return out;
}

function buyResourceCandidates(ctx: Ctx): Candidate[] {
  if (ctx.cap <= 0n) return [];
  const out: Candidate[] = [];
  const entries = Object.entries(ctx.view.marketPrices) as [
    ResourceType,
    { askDrops: string; bidDrops: string; supply: number },
  ][];
  const held = new Map<ResourceType, number>();
  for (const item of ctx.view.inventory)
    held.set(item.resourceType, (held.get(item.resourceType) ?? 0) + item.quantity);
  for (const [resourceType, price] of entries) {
    const ask = BigInt(price.askDrops);
    const emaRaw = ctx.mem.askEmaDrops[resourceType];
    if (ask <= 0n || emaRaw === undefined || price.supply <= 0) continue;
    if ((held.get(resourceType) ?? 0) >= TUNING.maxHeldUnits) continue;
    const ema = BigInt(emaRaw);
    if (ask > pct(ema, TUNING.cheapAskPercent)) continue;
    const affordable = Number(ctx.cap / ask);
    const quantity = Math.min(TUNING.maxResourceQuantity, price.supply, affordable);
    if (quantity < 1) continue;
    out.push({
      action: {
        type: "BUY_RESOURCE",
        resourceType,
        quantity,
        maxUnitPriceDrops: ask.toString(),
      },
      expectedValueDrops: (ema - ask) * BigInt(quantity),
      risk: 0.3,
      note: `Buying ${quantity} ${resourceType} from the market at ${ask} drops each.`,
    });
  }
  for (const listing of ctx.view.resourceListings) {
    if (listing.sellerAgentId === ctx.me || listing.quantity <= 0) continue;
    if ((held.get(listing.resourceType) ?? 0) >= TUNING.maxHeldUnits) continue;
    const market = ctx.view.marketPrices[listing.resourceType];
    if (!market) continue;
    const ask = BigInt(market.askDrops);
    const unit = BigInt(listing.unitPriceDrops);
    if (unit <= 0n || unit > pct(ask, TUNING.cheapAskPercent)) continue;
    const affordable = Number(ctx.cap / unit);
    const quantity = Math.min(TUNING.maxResourceQuantity, listing.quantity, affordable);
    if (quantity < 1) continue;
    out.push({
      action: {
        type: "BUY_RESOURCE",
        resourceType: listing.resourceType,
        quantity,
        maxUnitPriceDrops: unit.toString(),
        listingId: listing.id,
      },
      expectedValueDrops: (ask - unit) * BigInt(quantity),
      risk: 0.3,
      note: `Buying ${quantity} ${listing.resourceType} from a listing at ${unit} drops each.`,
    });
  }
  return out;
}

function postJobCandidate(ctx: Ctx): Candidate | undefined {
  if (ctx.cap <= 0n) return undefined;
  const openMine = ctx.view.myJobs.filter(
    (j) => j.posterAgentId === ctx.me && (j.status === "open" || j.status === "claimed"),
  ).length;
  if (openMine >= TUNING.maxOpenPostedJobs) return undefined;
  const lastPost = ctx.mem.lastJobPostTick;
  if (lastPost !== null && ctx.tick - lastPost < TUNING.jobPostIntervalTicks) return undefined;
  const reward = min(ctx.cap, ctx.spendable / 50n, TUNING.jobRewardCap);
  if (reward < TUNING.minJobReward) return undefined;
  const resource = preferredResource(ctx) ?? "ore";
  const scoutsNearby = ctx.view.nearbyAgents.filter((a) => a.id !== ctx.me).length;
  return {
    action: {
      type: "POST_JOB",
      title: `Scout ${resource} deposits`,
      description: `Report the location and quantity of a ${resource} deposit. Reward paid on a verified report.`,
      rewardDrops: reward.toString(),
      requirement: { kind: "report_resource_location", resourceType: resource },
      expiresInTicks: TUNING.jobExpiryTicks,
    },
    expectedValueDrops: reward / 4n + BigInt(scoutsNearby) * 1_000n,
    risk: 0.3,
    note: `Posting a job to scout ${resource} deposits for ${reward} drops.`,
  };
}

function tipCandidate(ctx: Ctx): Candidate | undefined {
  if (ctx.cap <= 0n) return undefined;
  const last = ctx.mem.lastTipTick;
  if (last !== null && ctx.tick - last < TUNING.tipIntervalTicks) return undefined;
  const partners = ctx.view.nearbyAgents
    .filter((a) => a.id !== ctx.me && a.status === "active")
    .sort((a, b) => b.reputation - a.reputation);
  const partner = partners[0];
  if (!partner) return undefined;
  const amount = min(ctx.cap, ctx.spendable / 100n, TUNING.tipCap);
  if (amount < TUNING.minTip) return undefined;
  return {
    action: {
      type: "TRANSFER",
      toAgentId: partner.id,
      amountDrops: amount.toString(),
      memo: "coalition tip",
    },
    expectedValueDrops: amount / 2n,
    risk: 0.2,
    note: `Tipping ${partner.name} ${amount} drops to build a coalition.`,
  };
}

const WAIT_CANDIDATE: Candidate = {
  action: { type: "WAIT" },
  expectedValueDrops: 0n,
  risk: 0,
  note: "Holding position.",
};

// ── objective strategies ───────────────────────────────────────────────────────

function strategyCandidates(ctx: Ctx): Candidate[] {
  const objective = ctx.view.objective;
  switch (objective) {
    case "maximize_net_worth":
      return [
        ...submitCandidates(ctx),
        ...acceptCandidates(ctx, TUNING.minJobRewardNetWorth),
        ...buyIntelCandidates(ctx, {
          kinds: ["SCOUT", "ANALYST"],
          sharePercent: 3n,
          minGapTicks: 8,
          skipIfFresh: true,
        }),
        ...optional(
          offerCandidate(
            ctx,
            "ANALYST",
            targetPrice(ctx, "ANALYST", TUNING.defaultPrices.ANALYST),
            2n,
            "Offering an ANALYST service",
          ),
        ),
        ...sellResourceCandidates(ctx),
        ...buyResourceCandidates(ctx),
      ];
    case "survive":
      return [
        ...submitCandidates(ctx),
        ...acceptCandidates(ctx, 1n),
        ...optional(
          ctx.view.myServices.some((s) => s.kind === "SCOUT")
            ? undefined
            : offerCandidate(
                ctx,
                "SCOUT",
                TUNING.cheapPrices.SCOUT,
                1n,
                "Offering a cheap SCOUT service",
              ),
        ),
        ...sellResourceCandidates(ctx),
      ];
    case "maximize_information":
      return [
        ...submitCandidates(ctx),
        ...acceptCandidates(ctx, 1n),
        ...buyIntelCandidates(ctx, {
          kinds: ["SCOUT"],
          sharePercent: 15n,
          minGapTicks: 3,
          valuePercent: 300n,
        }).map((c) => ({ ...c, expectedValueDrops: c.expectedValueDrops - bigRisk(c) })),
        ...buyIntelCandidates(ctx, { kinds: ["ANALYST"], sharePercent: 8n, minGapTicks: 3 }),
      ];
    case "maximize_reputation":
      return [
        ...submitCandidates(ctx, TUNING.reputationBonusDrops),
        ...acceptCandidates(ctx, 1n, TUNING.reputationBonusDrops),
        ...optional(
          ctx.view.myServices.some((s) => s.kind === "SCOUT")
            ? undefined
            : offerCandidate(
                ctx,
                "SCOUT",
                TUNING.cheapPrices.SCOUT,
                3n,
                "Offering a cheap SCOUT service",
              ),
        ),
        ...optional(
          ctx.view.myServices.some((s) => s.kind === "ANALYST")
            ? undefined
            : offerCandidate(
                ctx,
                "ANALYST",
                TUNING.cheapPrices.ANALYST,
                3n,
                "Offering a cheap ANALYST service",
              ),
        ),
      ];
    case "build_coalition":
      return [
        ...submitCandidates(ctx),
        ...acceptCandidates(ctx, 1n),
        ...optional(postJobCandidate(ctx)),
        ...optional(tipCandidate(ctx)),
        ...optional(
          ctx.view.myServices.some((s) => s.kind === "SCOUT")
            ? undefined
            : offerCandidate(
                ctx,
                "SCOUT",
                TUNING.defaultPrices.SCOUT,
                1n,
                "Offering a SCOUT service",
              ),
        ),
      ];
    case "information_broker": {
      const cheapestScout = ctx.view.availableServices
        .filter((s) => s.kind === "SCOUT" && s.sellerAgentId !== ctx.me)
        .map((s) => BigInt(s.priceDrops))
        .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))[0];
      const markup = max(
        cheapestScout === undefined ? 0n : pct(cheapestScout, TUNING.brokerMarkupPercent),
        TUNING.brokerMinPrice,
      );
      const canResell = hasFreshKnowledge(ctx);
      return [
        ...submitCandidates(ctx),
        ...buyIntelCandidates(ctx, {
          kinds: ["SCOUT"],
          sharePercent: 10n,
          minGapTicks: 5,
          skipIfFresh: true,
          valuePercent: 200n,
        }),
        ...optional(
          canResell
            ? offerCandidate(
                ctx,
                "SCOUT",
                targetPrice(ctx, "SCOUT", markup),
                3n,
                "Reselling SCOUT intel",
              )
            : undefined,
        ),
        ...optional(
          canResell
            ? offerCandidate(
                ctx,
                "ANALYST",
                targetPrice(ctx, "ANALYST", pct(markup, 120n)),
                2n,
                "Offering ANALYST reports built on purchased intel",
              )
            : undefined,
        ),
      ];
    }
    case "profitable_service":
      return [
        ...submitCandidates(ctx),
        ...acceptCandidates(ctx, TUNING.minJobRewardNetWorth),
        ...optional(
          offerCandidate(
            ctx,
            "ANALYST",
            targetPrice(ctx, "ANALYST", TUNING.premiumAnalystPrice),
            2n,
            "Offering a premium ANALYST service",
          ),
        ),
        ...sellResourceCandidates(ctx),
      ];
    default: {
      const exhaustive: never = objective;
      return exhaustive;
    }
  }
}

function bigRisk(c: Candidate): bigint {
  return BigInt(Math.round(c.risk * 10_000));
}

function optional<T>(value: T | undefined): T[] {
  return value === undefined ? [] : [value];
}

function referencesOnlyKnownIds(view: ObservationView, action: AgentAction): boolean {
  switch (action.type) {
    case "BUY_SERVICE":
      return view.availableServices.some((s) => s.id === action.serviceId);
    case "ACCEPT_JOB":
      return view.availableJobs.some((j) => j.id === action.jobId);
    case "SUBMIT_JOB":
      return view.myJobs.some((j) => j.id === action.jobId);
    case "TRANSFER":
      return view.nearbyAgents.some((a) => a.id === action.toAgentId);
    case "BUY_RESOURCE":
      return (
        action.listingId === undefined ||
        view.resourceListings.some((l) => l.id === action.listingId)
      );
    default:
      return true;
  }
}

function spendOf(action: AgentAction): bigint {
  switch (action.type) {
    case "BUY_SERVICE":
      return BigInt(action.maxPriceDrops);
    case "TRANSFER":
      return BigInt(action.amountDrops);
    case "POST_JOB":
      return BigInt(action.rewardDrops);
    case "BUY_RESOURCE":
      return BigInt(action.maxUnitPriceDrops) * BigInt(action.quantity);
    default:
      return 0n;
  }
}

const planMeta = new WeakMap<Plan, PlanMeta>();

export class DeterministicAgent implements AgentBrain {
  readonly kind = "deterministic" as const;
  readonly model = "deterministic-v1";
  private readonly worldSeed: string;

  constructor(options: DeterministicAgentOptions) {
    this.worldSeed = options.worldSeed;
  }

  async observe(obs: Observation): Promise<ObservationView> {
    return compactObservation(obs);
  }

  async plan(view: ObservationView): Promise<Plan> {
    const rng = new SeededRandom(deriveSeed(this.worldSeed, view.agentId, view.tick));
    const cap = spendCapDrops(view);
    const ctx: Ctx = {
      view,
      mem: parseMemory(view.memory),
      me: view.agentId,
      tick: view.tick,
      cap,
      spendable: BigInt(view.spendableDrops),
      rng,
    };
    const raw = view.status === "active" ? strategyCandidates(ctx) : [];
    const safe = raw.filter(
      (c) => spendOf(c.action) <= cap && referencesOnlyKnownIds(view, c.action),
    );
    const keyed = [...safe, WAIT_CANDIDATE].map((candidate) => ({
      candidate,
      tieKey: rng.next(),
    }));
    keyed.sort((a, b) => {
      if (a.candidate.expectedValueDrops !== b.candidate.expectedValueDrops)
        return a.candidate.expectedValueDrops > b.candidate.expectedValueDrops ? -1 : 1;
      if (a.candidate.risk !== b.candidate.risk) return a.candidate.risk - b.candidate.risk;
      return a.tieKey - b.tieKey;
    });
    const plan: Plan = {
      candidates: keyed.map((k) => k.candidate),
      notes: [
        `Objective ${view.objective}.`,
        `Spend cap ${cap} drops this action.`,
        `${safe.length} viable candidate${safe.length === 1 ? "" : "s"} besides waiting.`,
      ],
    };
    planMeta.set(plan, { objective: view.objective, capDrops: cap, agentName: view.name });
    return plan;
  }

  async chooseAction(plan: Plan): Promise<Decision> {
    const best = plan.candidates[0] ?? WAIT_CANDIDATE;
    const meta = planMeta.get(plan);
    const alternatives = plan.candidates
      .slice(1, 5)
      .map((c) => c.action.type)
      .filter((t, i, all) => all.indexOf(t) === i);
    return {
      action: best.action,
      summary: best.note,
      reason: defaultReason(best, plan),
      rationale: {
        ...(meta ? { goal: meta.objective } : {}),
        expectedValueDrops: best.expectedValueDrops.toString(),
        alternativesConsidered: alternatives,
        confidence: Math.round((1 - best.risk) * 100) / 100,
      },
    };
  }

  async summarizeReason(decision: Decision, plan: Plan): Promise<string> {
    const best = plan.candidates[0] ?? WAIT_CANDIDATE;
    return defaultReason({ ...best, action: decision.action }, plan);
  }

  async reflectOnOutcome(
    obs: Observation,
    decision: Decision,
    outcome: ExecutionOutcome,
  ): Promise<Record<string, unknown>> {
    return memoryToRecord(updateMemory(obs, decision, outcome));
  }

  decide(obs: Observation): Promise<DecisionResult> {
    return runDecide(this, obs);
  }
}

function defaultReason(best: Candidate, plan: Plan): string {
  const others = plan.candidates.length - 1;
  switch (best.action.type) {
    case "WAIT":
      return others > 0
        ? "No candidate beats holding position this tick."
        : "Nothing worth doing within my budget this tick.";
    case "BUY_SERVICE":
      return "Highest expected utility within my remaining budget.";
    case "SELL_SERVICE":
      return best.note.startsWith("Re-pricing")
        ? "Adjusting my price to observed demand."
        : "Listing a service to earn steady revenue.";
    case "ACCEPT_JOB":
      return "The reward is worth the work and I can deliver it.";
    case "SUBMIT_JOB":
      return "Completing a claimed job collects the reward and reputation.";
    case "TRANSFER":
      return "A small tip builds goodwill with a reputable partner.";
    case "POST_JOB":
      return "Hiring others to gather intel is cheaper than doing it alone.";
    case "BUY_RESOURCE":
      return "The ask is below the recent average price.";
    case "SELL_RESOURCE":
      return "The market bid exceeds my cost basis.";
    default: {
      const exhaustive: never = best.action;
      return exhaustive;
    }
  }
}
