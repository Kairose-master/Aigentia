import { worldEvent } from "../events";
import { rejected, success, type ActionHandler } from "./types";

/** ACCEPT_JOB: atomic claim; two agents racing for one job leaves exactly one claimer. */
export const executeAcceptJob: ActionHandler<"ACCEPT_JOB"> = async (action, ctx) => {
  const claimed = await ctx.store.claimJob(action.jobId, ctx.agent.id, ctx.tick);
  if (!claimed) return rejected(`Job ${action.jobId} was no longer open.`);
  const job = await ctx.store.getJob(action.jobId);
  if (!job) return rejected(`Job ${action.jobId} vanished after the claim.`);
  const poster = await ctx.store.getAgent(job.posterAgentId);
  const posterName = poster?.name ?? job.posterAgentId;
  return success(`Accepted ${posterName}'s job "${job.title}".`, {
    events: [
      worldEvent({
        tick: ctx.tick,
        at: ctx.now,
        type: "JOB_CLAIMED",
        agentId: ctx.agent.id,
        counterpartyId: job.posterAgentId,
        amountDrops: job.rewardDrops,
        message: `${ctx.agent.name} accepted ${posterName}'s job: ${job.title}`,
        payload: { jobId: job.id },
      }),
    ],
  });
};
