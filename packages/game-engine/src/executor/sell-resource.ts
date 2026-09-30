import { createPaymentIntent } from "@aigentia/economy";
import { parseDrops } from "@aigentia/shared";
import { worldEvent } from "../events";
import { treasuryPayer } from "../settlement";
import { fmtXrp } from "../world";
import { consumeInventory } from "./inventory";
import { failed, rejected, success, type ActionHandler } from "./types";

/**
 * SELL_RESOURCE: `toMarket` sells to the world market at the bid (the treasury pays the
 * agent through Settlement); otherwise the units leave the inventory into a listing.
 */
export const executeSellResource: ActionHandler<"SELL_RESOURCE"> = async (action, ctx) => {
  const inventory = await ctx.store.getInventory(ctx.agent.id);
  const held = inventory
    .filter((i) => i.resourceType === action.resourceType)
    .reduce((s, i) => s + i.quantity, 0);
  if (held < action.quantity) {
    return rejected(`Only ${held} ${action.resourceType} in inventory.`);
  }
  const nextInventoryId = (): string => ctx.ids.next("inventory", ctx.scope);

  if (!action.toMarket) {
    const unit = parseDrops(action.unitPriceDrops);
    await consumeInventory(
      ctx.store,
      ctx.agent,
      action.resourceType,
      action.quantity,
      nextInventoryId,
    );
    const listing = await ctx.store.createListing({
      id: ctx.ids.next("listing", ctx.scope),
      sellerAgentId: ctx.agent.id,
      resourceType: action.resourceType,
      quantity: action.quantity,
      unitPriceDrops: unit,
      tick: ctx.tick,
      createdAt: ctx.now,
    });
    return success(`Listed ${action.quantity} ${action.resourceType} at ${fmtXrp(unit)} each.`, {
      events: [
        worldEvent({
          tick: ctx.tick,
          at: ctx.now,
          type: "RESOURCE_SOLD",
          agentId: ctx.agent.id,
          amountDrops: unit * BigInt(action.quantity),
          message: `${ctx.agent.name} listed ${action.quantity} ${action.resourceType} at ${fmtXrp(unit)} each`,
          payload: { listingId: listing.id, listed: true, quantity: action.quantity },
        }),
      ],
    });
  }

  const price = (await ctx.store.getMarketPrices()).find(
    (p) => p.resourceType === action.resourceType,
  );
  if (!price || price.bidDrops <= 0n) return rejected(`No market bid for ${action.resourceType}.`);
  const total = price.bidDrops * BigInt(action.quantity);
  const treasury = treasuryPayer(ctx.treasury);
  const intent = createPaymentIntent({
    id: ctx.ids.next("intent", ctx.scope),
    agentId: treasury.id,
    purpose: "trade",
    destinationAddress: ctx.agent.walletAddress,
    destinationAgentId: ctx.agent.id,
    amount: total,
    actionRef: { kind: "market", id: action.resourceType },
    memo: `market sell ${action.quantity} ${action.resourceType}`.slice(0, 200),
    createdAt: ctx.now.toISOString(),
  });
  const outcome = await ctx.settlement.pay(intent, {
    agent: treasury,
    tick: ctx.tick,
    scope: ctx.scope,
    description: `for ${action.quantity} ${action.resourceType}`,
  });
  const ref = {
    paymentId: outcome.paymentId,
    ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
  };
  if (outcome.status !== "validated") {
    return failed(
      `The market could not pay for ${action.quantity} ${action.resourceType}: ${outcome.error ?? outcome.status}.`,
      ref,
    );
  }
  await consumeInventory(
    ctx.store,
    ctx.agent,
    action.resourceType,
    action.quantity,
    nextInventoryId,
  );
  await ctx.store.setMarketPrice({ ...price, supply: price.supply + action.quantity });
  await ctx.store.recordTrade({
    id: ctx.ids.next("trade", ctx.scope),
    buyerAgentId: null,
    sellerAgentId: ctx.agent.id,
    counterparty: "market",
    resourceType: action.resourceType,
    quantity: action.quantity,
    unitPriceDrops: price.bidDrops,
    totalDrops: total,
    paymentId: outcome.paymentId,
    listingId: null,
    tick: ctx.tick,
    createdAt: ctx.now,
  });
  return success(
    `Sold ${action.quantity} ${action.resourceType} to the market and earned ${fmtXrp(total)}.`,
    {
      ...ref,
      events: [
        worldEvent({
          tick: ctx.tick,
          at: ctx.now,
          type: "RESOURCE_SOLD",
          agentId: ctx.agent.id,
          amountDrops: total,
          txHash: outcome.txHash ?? null,
          message: `${ctx.agent.name} sold ${action.quantity} ${action.resourceType} to the market and earned ${fmtXrp(total)}`,
          payload: {
            quantity: action.quantity,
            unitPriceDrops: price.bidDrops.toString(),
            paymentId: outcome.paymentId,
          },
        }),
      ],
    },
  );
};
