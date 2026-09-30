import { parseDrops } from "@aigentia/shared";
import { fmtXrp } from "../world";
import { failed, rejected, success, type ActionHandler } from "./types";

/** BUY_SERVICE: quote → pay → execute through the ServicePurchaser (events come from it). */
export const executeBuyService: ActionHandler<"BUY_SERVICE"> = async (action, ctx) => {
  const service = await ctx.store.getService(action.serviceId);
  if (!service) return rejected(`Service ${action.serviceId} does not exist.`);
  const result = await ctx.purchaser.purchase({
    buyer: ctx.agent,
    service,
    input: action.input,
    maxPriceDrops: parseDrops(action.maxPriceDrops),
    tick: ctx.tick,
    scope: ctx.scope,
  });
  const ref = {
    ...(result.paymentId !== undefined ? { paymentId: result.paymentId } : {}),
    ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
  };
  switch (result.status) {
    case "fulfilled":
      return success(
        `Bought ${service.kind} from ${result.sellerName} for ${fmtXrp(result.priceDrops)}.`,
        { costDrops: result.priceDrops, ...ref },
      );
    case "rejected":
      return rejected(
        `Rejected ${service.kind} from ${result.sellerName}: ${result.error ?? "invalid request"}.`,
      );
    case "denied":
      return rejected(
        `Rejected ${service.kind} from ${result.sellerName} because the policy denied the payment (${result.error ?? "denied"}).`,
        ref,
      );
    case "payment_failed":
      return failed(
        `Payment for ${service.kind} from ${result.sellerName} failed: ${result.error ?? "unknown"}.`,
        ref,
      );
    case "service_failed":
      return failed(
        `${result.sellerName} failed to deliver ${service.kind}: ${result.error ?? "unknown"}.`,
        { costDrops: result.priceDrops, ...ref },
      );
    default: {
      const exhaustive: never = result.status;
      return failed(`Unknown purchase status ${String(exhaustive)}.`);
    }
  }
};
