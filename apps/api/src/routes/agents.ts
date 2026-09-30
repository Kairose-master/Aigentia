import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dtoContext, notFound, rankMarket, summariseAgents, type RouteContext } from "../context";
import { agentProfileDto, decisionTraceDto, jobDto, paymentDto, serviceListingDto } from "../dto";
import { parseWith } from "../query";

const agentsQuery = z.object({ experimentId: z.string().optional() });

export const PROFILE_LIMITS = {
  payments: 50,
  decisions: 50,
  reputation: 100,
  snapshots: 500,
} as const;

export function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get("/api/agents", async (request) => {
    const q = parseWith(agentsQuery, request.query, "query");
    const agents = await ctx.store.listAgents(
      q.experimentId === undefined ? {} : { experimentId: q.experimentId },
    );
    return summariseAgents(ctx, agents);
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request) => {
    const agent = await ctx.store.getAgent(request.params.id);
    if (!agent) throw notFound("agent", request.params.id);
    const [summary] = await summariseAgents(ctx, [agent]);
    if (!summary) throw notFound("agent", request.params.id);
    const [agents, state, inventory, services, jobs, payments, decisions, reputation, snapshots] =
      await Promise.all([
        ctx.store.listAgents(),
        ctx.store.getSimulationState(),
        ctx.store.getInventory(agent.id),
        ctx.store.listServices({ sellerAgentId: agent.id }),
        ctx.store.listAgentJobs(agent.id),
        ctx.store.listPaymentsForAgent(agent.id, PROFILE_LIMITS.payments),
        ctx.store.listDecisions(agent.id, PROFILE_LIMITS.decisions),
        ctx.store.listReputationEvents(agent.id, PROFILE_LIMITS.reputation),
        ctx.store.listSnapshots(agent.id, PROFILE_LIMITS.snapshots),
      ]);
    const dto = dtoContext(ctx, agents);
    const agentsById = new Map(agents.map((a) => [a.id, a]));
    const ranked = rankMarket(services, agentsById, ctx.ranker, state.currentTick);
    const jobDtos = [];
    for (const job of jobs) {
      const payment = job.paymentId === null ? null : await ctx.store.getPayment(job.paymentId);
      jobDtos.push(jobDto(job, dto, payment?.txHash ?? null));
    }
    return agentProfileDto({
      agent: summary,
      budgetPolicy: agent.budgetPolicy,
      inventory,
      services: ranked.map((r) => serviceListingDto(r.service, agent, r.score)),
      jobs: jobDtos,
      payments: payments.map((p) => paymentDto(p, dto)),
      decisions: decisions.map((d) => decisionTraceDto(d, dto)),
      reputation,
      snapshots,
    });
  });
}
