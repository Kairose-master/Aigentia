import { parseDrops } from "@aigentia/shared";
import { worldEvent } from "../events";
import { fmtXrp } from "../world";
import { rejected, success, type ActionHandler } from "./types";

/**
 * POST_JOB: the reward is not escrowed on-chain; it is paid by the poster on completion.
 * The validator already checked the poster can afford it now.
 */
export const executePostJob: ActionHandler<"POST_JOB"> = async (action, ctx) => {
  const reward = parseDrops(action.rewardDrops);
  const minimum = parseDrops(ctx.agent.budgetPolicy.minimumBalanceDrops);
  if (reward > ctx.balance.spendableDrops - minimum) {
    return rejected(`Cannot afford a ${fmtXrp(reward)} reward.`);
  }
  const job = await ctx.store.createJob({
    id: ctx.ids.next("job", ctx.scope),
    posterAgentId: ctx.agent.id,
    title: action.title,
    description: action.description,
    rewardDrops: reward,
    requirement: action.requirement ? { ...action.requirement } : null,
    createdAtTick: ctx.tick,
    expiresAtTick: ctx.tick + action.expiresInTicks,
    createdAt: ctx.now,
  });
  return success(`Posted job "${job.title}" for ${fmtXrp(reward)}.`, {
    events: [
      worldEvent({
        tick: ctx.tick,
        at: ctx.now,
        type: "JOB_POSTED",
        agentId: ctx.agent.id,
        amountDrops: reward,
        message: `${ctx.agent.name} posted a job: ${job.title} (${fmtXrp(reward)})`,
        payload: { jobId: job.id, expiresAtTick: job.expiresAtTick },
      }),
    ],
  });
};
