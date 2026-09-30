import { errorMessage } from "@aigentia/shared";
import type { AgentAction } from "@aigentia/protocol";
import { executeAcceptJob } from "./accept-job";
import { executeBuyResource } from "./buy-resource";
import { executeBuyService } from "./buy-service";
import { executePostJob } from "./post-job";
import { executeSellResource } from "./sell-resource";
import { executeSellService } from "./sell-service";
import { executeSubmitJob } from "./submit-job";
import { executeTransfer } from "./transfer";
import { failed, type ExecutionContext, type ExecutionResult } from "./types";
import { executeWait } from "./wait";

/** One handler per action type; anything thrown becomes a failed result (never aborts a tick). */
export async function executeAction(
  action: AgentAction,
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  try {
    switch (action.type) {
      case "WAIT":
        return await executeWait(action, ctx);
      case "BUY_SERVICE":
        return await executeBuyService(action, ctx);
      case "SELL_SERVICE":
        return await executeSellService(action, ctx);
      case "POST_JOB":
        return await executePostJob(action, ctx);
      case "ACCEPT_JOB":
        return await executeAcceptJob(action, ctx);
      case "SUBMIT_JOB":
        return await executeSubmitJob(action, ctx);
      case "TRANSFER":
        return await executeTransfer(action, ctx);
      case "BUY_RESOURCE":
        return await executeBuyResource(action, ctx);
      case "SELL_RESOURCE":
        return await executeSellResource(action, ctx);
      default: {
        const exhaustive: never = action;
        return failed(`Unknown action ${JSON.stringify(exhaustive)}.`);
      }
    }
  } catch (e) {
    return failed(`${action.type} failed: ${errorMessage(e)}`);
  }
}

export type { ActionHandler, ActionOf, ExecutionContext, ExecutionResult } from "./types";
export { verifySubmission } from "./submit-job";
export { serviceEndpoint, listAgentService } from "./sell-service";
export type { ListServiceParams, ListServiceResult } from "./sell-service";
export { consumeInventory } from "./inventory";
