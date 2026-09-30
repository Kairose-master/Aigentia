import { createPaymentIntent } from "@aigentia/economy";
import { parseDrops } from "@aigentia/shared";
import { worldEvent } from "../events";
import { fmtXrp } from "../world";
import { failed, rejected, success, type ActionHandler, type ExecutionContext } from "./types";

function paymentProblem(
  outcome: { status: string; error?: string; decision: { violations: { rule: string }[] } },
  what: string,
): string {
  return outcome.status === "denied"
    ? `${what} denied by policy (${outcome.decision.violations.map((v) => v.rule).join(", ")})`
    : `${what} failed: ${outcome.error ?? "unknown"}`;
}

async function buyFromListing(
  action: Parameters<ActionHandler<"BUY_RESOURCE">>[0] & { listingId: string },
  ctx: ExecutionContext,
): ReturnType<ActionHandler<"BUY_RESOURCE">> {
  const listing = await ctx.store.getListing(action.listingId);
  if (!listing || listing.status !== "open") return rejected("Listing is no longer open.");
  if (listing.sellerAgentId === ctx.agent.id) return rejected("Cannot buy your own listing.");
  if (listing.resourceType !== action.resourceType || listing.quantity < action.quantity) {
    return rejected(`Listing cannot supply ${action.quantity} ${action.resourceType}.`);
  }
  if (listing.unitPriceDrops > parseDrops(action.maxUnitPriceDrops)) {
    return rejected(`Listing price ${fmtXrp(listing.unitPriceDrops)} exceeds the ceiling.`);
  }
  const seller = await ctx.store.getAgent(listing.sellerAgentId);
  if (!seller) return rejected("Listing seller no longer exists.");
  const total = listing.unitPriceDrops * BigInt(action.quantity);
  const intent = createPaymentIntent({
    id: ctx.ids.next("intent", ctx.scope),
    agentId: ctx.agent.id,
    purpose: "trade",
    destinationAddress: seller.walletAddress,
    destinationAgentId: seller.id,
    amount: total,
    actionRef: { kind: "listing", id: listing.id },
    memo: `trade ${listing.id}`.slice(0, 200),
    createdAt: ctx.now.toISOString(),
  });
  const outcome = await ctx.settlement.pay(intent, {
    agent: ctx.agent,
    tick: ctx.tick,
    scope: ctx.scope,
    description: `for ${action.quantity} ${action.resourceType}`,
  });
  const ref = {
    paymentId: outcome.paymentId,
    ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
  };
  if (outcome.status !== "validated") {
    const problem = paymentProblem(
      outcome,
      `Buying ${action.quantity} ${action.resourceType} from ${seller.name}`,
    );
    return outcome.status === "denied" ? rejected(`${problem}.`, ref) : failed(`${problem}.`, ref);
  }
  const filled = await ctx.store.fillListing(listing.id, action.quantity);
  if (!filled) {
    return failed(`Paid ${seller.name} but the listing changed before it could be filled.`, {
      costDrops: total,
      ...ref,
    });
  }
  await ctx.store.adjustInventory(
    ctx.agent.id,
    action.resourceType,
    ctx.agent.locationId,
    action.quantity,
    ctx.ids.next("inventory", ctx.scope),
  );
  await ctx.store.recordTrade({
    id: ctx.ids.next("trade", ctx.scope),
    buyerAgentId: ctx.agent.id,
    sellerAgentId: seller.id,
    counterparty: "agent",
    resourceType: action.resourceType,
    quantity: action.quantity,
    unitPriceDrops: listing.unitPriceDrops,
    totalDrops: total,
    paymentId: outcome.paymentId,
    listingId: listing.id,
    tick: ctx.tick,
    createdAt: ctx.now,
  });
  return success(
    `Bought ${action.quantity} ${action.resourceType} from ${seller.name} for ${fmtXrp(total)}.`,
    {
      costDrops: total,
      ...ref,
      events: [
        worldEvent({
          tick: ctx.tick,
          at: ctx.now,
          type: "RESOURCE_BOUGHT",
          agentId: ctx.agent.id,
          counterpartyId: seller.id,
          amountDrops: total,
          txHash: outcome.txHash ?? null,
          message: `${ctx.agent.name} bought ${action.quantity} ${action.resourceType} from ${seller.name} for ${fmtXrp(total)}`,
          payload: {
            listingId: listing.id,
            quantity: action.quantity,
            paymentId: outcome.paymentId,
          },
        }),
      ],
    },
  );
}

/** BUY_RESOURCE: from another agent's listing, or from the world market at the ask (paid to the treasury). */
export const executeBuyResource: ActionHandler<"BUY_RESOURCE"> = async (action, ctx) => {
  if (action.listingId !== undefined) {
    return buyFromListing({ ...action, listingId: action.listingId }, ctx);
  }
  const price = (await ctx.store.getMarketPrices()).find(
    (p) => p.resourceType === action.resourceType,
  );
  if (!price) return rejected(`No market for ${action.resourceType}.`);
  if (price.supply < action.quantity)
    return rejected(`Market only holds ${price.supply} ${action.resourceType}.`);
  if (price.askDrops > parseDrops(action.maxUnitPriceDrops)) {
    return rejected(`Market ask ${fmtXrp(price.askDrops)} exceeds the ceiling.`);
  }
  const total = price.askDrops * BigInt(action.quantity);
  const intent = createPaymentIntent({
    id: ctx.ids.next("intent", ctx.scope),
    agentId: ctx.agent.id,
    purpose: "trade",
    destinationAddress: ctx.treasury.address,
    destinationAgentId: null,
    amount: total,
    actionRef: { kind: "market", id: action.resourceType },
    memo: `market buy ${action.quantity} ${action.resourceType}`.slice(0, 200),
    createdAt: ctx.now.toISOString(),
  });
  const outcome = await ctx.settlement.pay(intent, {
    agent: ctx.agent,
    tick: ctx.tick,
    scope: ctx.scope,
    description: `for ${action.quantity} ${action.resourceType}`,
  });
  const ref = {
    paymentId: outcome.paymentId,
    ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
  };
  if (outcome.status !== "validated") {
    const problem = paymentProblem(
      outcome,
      `Buying ${action.quantity} ${action.resourceType} from the market`,
    );
    return outcome.status === "denied" ? rejected(`${problem}.`, ref) : failed(`${problem}.`, ref);
  }
  await ctx.store.setMarketPrice({ ...price, supply: Math.max(0, price.supply - action.quantity) });
  await ctx.store.adjustInventory(
    ctx.agent.id,
    action.resourceType,
    ctx.agent.locationId,
    action.quantity,
    ctx.ids.next("inventory", ctx.scope),
  );
  await ctx.store.recordTrade({
    id: ctx.ids.next("trade", ctx.scope),
    buyerAgentId: ctx.agent.id,
    sellerAgentId: null,
    counterparty: "market",
    resourceType: action.resourceType,
    quantity: action.quantity,
    unitPriceDrops: price.askDrops,
    totalDrops: total,
    paymentId: outcome.paymentId,
    listingId: null,
    tick: ctx.tick,
    createdAt: ctx.now,
  });
  return success(
    `Bought ${action.quantity} ${action.resourceType} from the market for ${fmtXrp(total)}.`,
    {
      costDrops: total,
      ...ref,
      events: [
        worldEvent({
          tick: ctx.tick,
          at: ctx.now,
          type: "RESOURCE_BOUGHT",
          agentId: ctx.agent.id,
          amountDrops: total,
          txHash: outcome.txHash ?? null,
          message: `${ctx.agent.name} bought ${action.quantity} ${action.resourceType} from the market for ${fmtXrp(total)}`,
          payload: {
            quantity: action.quantity,
            unitPriceDrops: price.askDrops.toString(),
            paymentId: outcome.paymentId,
          },
        }),
      ],
    },
  );
};
