import { createPaymentIntent } from "@aigentia/economy";
import { RESOURCE_TYPES, type ResourceType } from "@aigentia/shared";
import { worldEvent } from "../events";
import { applyAgentReputation } from "../reputation";
import type { AgentRecord, JobRecord, WorldStore } from "../store/types";
import { fmtXrp } from "../world";
import { failed, rejected, success, type ActionHandler, type ExecutionContext } from "./types";

type Verification = { ok: true; note: string } | { ok: false; reason: string };

const RESOURCE_SET = new Set<string>(RESOURCE_TYPES);

function asResourceType(value: unknown): ResourceType | undefined {
  return typeof value === "string" && RESOURCE_SET.has(value) ? (value as ResourceType) : undefined;
}

/**
 * Check a submission against the job's structured requirement and apply its side effects:
 *   deliver_resource         → the worker's units at the delivery location move to the poster
 *   report_resource_location → the named location must hold a deposit of that resource
 *   analysis                 → a non-empty `report` string or `analysis` list
 * Jobs without a requirement are accepted as delivered.
 */
export async function verifySubmission(
  job: JobRecord,
  poster: AgentRecord,
  worker: AgentRecord,
  submission: Record<string, unknown>,
  store: WorldStore,
  nextInventoryId: () => string,
): Promise<Verification> {
  const req = job.requirement ?? {};
  const kind = typeof req["kind"] === "string" ? req["kind"] : undefined;
  if (kind === undefined) return { ok: true, note: "no structured requirement" };

  if (kind === "deliver_resource") {
    const resourceType = asResourceType(req["resourceType"]);
    if (!resourceType) return { ok: false, reason: "job names no deliverable resource" };
    const quantityRaw = req["quantity"];
    const quantity =
      typeof quantityRaw === "number" && Number.isInteger(quantityRaw) && quantityRaw > 0
        ? quantityRaw
        : 1;
    const locationId =
      typeof req["locationId"] === "string" ? req["locationId"] : poster.locationId;
    const inventory = await store.getInventory(worker.id);
    const held =
      inventory.find((i) => i.resourceType === resourceType && i.locationId === locationId)
        ?.quantity ?? 0;
    if (held < quantity) {
      return {
        ok: false,
        reason: `needs ${quantity} ${resourceType} at ${locationId}, worker holds ${held} there`,
      };
    }
    await store.transaction(async (tx) => {
      await tx.adjustInventory(worker.id, resourceType, locationId, -quantity, nextInventoryId());
      await tx.adjustInventory(poster.id, resourceType, locationId, quantity, nextInventoryId());
    });
    return { ok: true, note: `delivered ${quantity} ${resourceType} at ${locationId}` };
  }

  if (kind === "report_resource_location") {
    const resourceType =
      asResourceType(req["resourceType"]) ?? asResourceType(submission["resourceType"]);
    const locationId = submission["locationId"];
    if (typeof locationId !== "string" || !locationId) {
      return { ok: false, reason: "submission names no locationId" };
    }
    const resources = await store.listResources();
    const deposit = resources.find(
      (r) =>
        r.locationId === locationId &&
        r.quantity > 0 &&
        (resourceType === undefined || r.resourceType === resourceType),
    );
    if (!deposit) {
      return {
        ok: false,
        reason: `no ${resourceType ?? "resource"} deposit at ${locationId}`,
      };
    }
    return { ok: true, note: `reported ${deposit.resourceType} at ${locationId}` };
  }

  if (kind === "analysis") {
    const report = submission["report"];
    const analysis = submission["analysis"];
    if (typeof report === "string" && report.trim().length > 0) {
      return { ok: true, note: "analysis report received" };
    }
    if (Array.isArray(analysis) && analysis.length > 0) {
      return { ok: true, note: `analysis of ${analysis.length} items received` };
    }
    return { ok: false, reason: "submission has no report or analysis" };
  }

  return { ok: false, reason: `unknown requirement kind ${kind}` };
}

async function failTheJob(
  job: JobRecord,
  poster: AgentRecord,
  reason: string,
  ctx: ExecutionContext,
  penaliseWorker: boolean,
): Promise<void> {
  await ctx.store.failJob(job.id);
  if (penaliseWorker) {
    await applyAgentReputation(ctx.store, ctx.agent.id, "JOB_FAILED_WORKER", {
      tick: ctx.tick,
      at: ctx.now,
      ids: ctx.ids,
      scope: ctx.scope,
      refKind: "job",
      refId: job.id,
    });
  }
  await ctx.events.emitOne({
    tick: ctx.tick,
    at: ctx.now,
    type: "JOB_FAILED",
    agentId: ctx.agent.id,
    counterpartyId: poster.id,
    amountDrops: job.rewardDrops,
    message: `${ctx.agent.name}'s work on ${poster.name}'s job "${job.title}" failed: ${reason}`,
    payload: { jobId: job.id, reason },
  });
}

/** SUBMIT_JOB: verify against the requirement, then the poster pays the reward on success. */
export const executeSubmitJob: ActionHandler<"SUBMIT_JOB"> = async (action, ctx) => {
  const job = await ctx.store.getJob(action.jobId);
  if (!job) return rejected(`Job ${action.jobId} does not exist.`);
  if (job.claimedByAgentId !== ctx.agent.id || job.status !== "claimed") {
    return rejected(`Job "${job.title}" is not claimed by ${ctx.agent.name}.`);
  }
  const poster = await ctx.store.getAgent(job.posterAgentId);
  if (!poster) return rejected(`Poster of job "${job.title}" no longer exists.`);

  await ctx.store.submitJob(job.id, action.submission, ctx.tick);
  await ctx.events.emitOne({
    tick: ctx.tick,
    at: ctx.now,
    type: "JOB_SUBMITTED",
    agentId: ctx.agent.id,
    counterpartyId: poster.id,
    amountDrops: job.rewardDrops,
    message: `${ctx.agent.name} submitted work for ${poster.name}'s job: ${job.title}`,
    payload: { jobId: job.id },
  });

  const verification = await verifySubmission(
    job,
    poster,
    ctx.agent,
    action.submission,
    ctx.store,
    () => ctx.ids.next("inventory", ctx.scope),
  );
  if (!verification.ok) {
    await failTheJob(job, poster, verification.reason, ctx, true);
    return failed(`Submission for "${job.title}" rejected: ${verification.reason}.`);
  }

  const intent = createPaymentIntent({
    id: ctx.ids.next("intent", ctx.scope),
    agentId: poster.id,
    purpose: "job_reward",
    destinationAddress: ctx.agent.walletAddress,
    destinationAgentId: ctx.agent.id,
    amount: job.rewardDrops,
    actionRef: { kind: "job", id: job.id },
    memo: `job ${job.id}`.slice(0, 200),
    createdAt: ctx.now.toISOString(),
  });
  const outcome = await ctx.settlement.pay(intent, {
    agent: poster,
    tick: ctx.tick,
    scope: ctx.scope,
    description: `as reward for "${job.title}"`,
  });
  const ref = {
    paymentId: outcome.paymentId,
    ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
  };
  if (outcome.status !== "validated") {
    const reason =
      outcome.status === "denied"
        ? `reward payment denied by ${poster.name}'s policy`
        : `reward payment failed: ${outcome.error ?? "unknown"}`;
    await failTheJob(job, poster, reason, ctx, false);
    return failed(`Completed "${job.title}" but ${reason}.`, ref);
  }

  await ctx.store.completeJob(job.id, outcome.paymentId);
  const repCtx = {
    tick: ctx.tick,
    at: ctx.now,
    ids: ctx.ids,
    scope: ctx.scope,
    refKind: "job",
    refId: job.id,
  };
  await applyAgentReputation(ctx.store, ctx.agent.id, "JOB_COMPLETED_WORKER", repCtx);
  await applyAgentReputation(ctx.store, poster.id, "JOB_COMPLETED_POSTER", repCtx);
  return success(
    `Completed "${job.title}" and earned ${fmtXrp(job.rewardDrops)} (${verification.note}).`,
    {
      ...ref,
      events: [
        worldEvent({
          tick: ctx.tick,
          at: ctx.now,
          type: "JOB_COMPLETED",
          agentId: ctx.agent.id,
          counterpartyId: poster.id,
          amountDrops: job.rewardDrops,
          txHash: outcome.txHash ?? null,
          message: `${ctx.agent.name} completed ${poster.name}'s job "${job.title}" and earned ${fmtXrp(job.rewardDrops)}`,
          payload: { jobId: job.id, paymentId: outcome.paymentId, note: verification.note },
        }),
      ],
    },
  );
};
