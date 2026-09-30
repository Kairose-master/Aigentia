import { createPaymentIntent } from "@aigentia/economy";
import { parseDrops } from "@aigentia/shared";
import { worldEvent } from "../events";
import { fmtXrp } from "../world";
import { failed, rejected, success, type ActionHandler } from "./types";

/** TRANSFER: a plain XRP payment to another agent through Settlement (purpose "transfer"). */
export const executeTransfer: ActionHandler<"TRANSFER"> = async (action, ctx) => {
  const to = await ctx.store.getAgent(action.toAgentId);
  if (!to) return rejected(`Agent ${action.toAgentId} does not exist.`);
  const amount = parseDrops(action.amountDrops);
  const intent = createPaymentIntent({
    id: ctx.ids.next("intent", ctx.scope),
    agentId: ctx.agent.id,
    purpose: "transfer",
    destinationAddress: to.walletAddress,
    destinationAgentId: to.id,
    amount,
    actionRef: { kind: "decision", id: ctx.decisionId },
    ...(action.memo !== undefined ? { memo: action.memo } : {}),
    createdAt: ctx.now.toISOString(),
  });
  const outcome = await ctx.settlement.pay(intent, {
    agent: ctx.agent,
    tick: ctx.tick,
    scope: ctx.scope,
    ...(action.memo !== undefined ? { memo: action.memo, description: `(${action.memo})` } : {}),
  });
  const ref = {
    paymentId: outcome.paymentId,
    ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
  };
  if (outcome.status === "denied") {
    const rules = outcome.decision.violations.map((v) => v.rule).join(", ");
    return rejected(
      `Transfer of ${fmtXrp(amount)} to ${to.name} denied by policy (${rules}).`,
      ref,
    );
  }
  if (outcome.status === "failed") {
    return failed(
      `Transfer of ${fmtXrp(amount)} to ${to.name} failed: ${outcome.error ?? "unknown"}.`,
      ref,
    );
  }
  return success(`Sent ${to.name} ${fmtXrp(amount)}.`, {
    costDrops: amount,
    ...ref,
    events: [
      worldEvent({
        tick: ctx.tick,
        at: ctx.now,
        type: "TRANSFER_SENT",
        agentId: ctx.agent.id,
        counterpartyId: to.id,
        amountDrops: amount,
        txHash: outcome.txHash ?? null,
        message: `${ctx.agent.name} sent ${to.name} ${fmtXrp(amount)}${action.memo ? ` (${action.memo})` : ""}`,
        payload: { paymentId: outcome.paymentId },
      }),
    ],
  });
};
