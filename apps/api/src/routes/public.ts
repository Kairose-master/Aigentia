import { JOB_STATUSES, type JobStatus } from "@aigentia/shared";
import { experimentDto, jobDto, paymentDto, worldDto } from "../dto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  computeStats,
  dtoContext,
  isServiceKind,
  notFound,
  rankMarket,
  summariseAgents,
  type RouteContext,
} from "../context";
import { serviceListingDto } from "../dto";
import { parseWith } from "../query";
import { decodePaymentsCursor, encodePaymentsCursor } from "../read-model";
import { registerAgentRoutes } from "./agents";

const marketQuery = z.object({ kind: z.string().optional() });
const jobsQuery = z.object({ status: z.string().optional() });
const transactionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function registerPublicRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get("/health", async () => {
    const state = await ctx.store.getSimulationState();
    const now = ctx.clock();
    return {
      ok: true,
      ledger: ctx.runtime.ledger,
      network: ctx.network,
      tick: state.currentTick,
      running: state.running,
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - ctx.startedAt.getTime()) / 1000)),
      now: now.toISOString(),
    };
  });

  app.get("/api/stats", async () => computeStats(ctx));

  app.get("/api/world", async () => {
    const [state, locations, resources, marketPrices, agents] = await Promise.all([
      ctx.store.getSimulationState(),
      ctx.store.listLocations(),
      ctx.store.listResources(),
      ctx.store.getMarketPrices(),
      ctx.store.listAgents(),
    ]);
    return worldDto({
      tick: state.currentTick,
      locations,
      resources,
      marketPrices,
      agents: await summariseAgents(ctx, agents),
    });
  });

  registerAgentRoutes(app, ctx);

  app.get("/api/market", async (request) => {
    const q = parseWith(marketQuery, request.query, "query");
    if (q.kind !== undefined && !isServiceKind(q.kind)) {
      throw notFound("service kind", q.kind);
    }
    const [services, agents, state] = await Promise.all([
      ctx.store.listServices({
        status: "active",
        ...(q.kind && isServiceKind(q.kind) ? { kind: q.kind } : {}),
      }),
      ctx.store.listAgents(),
      ctx.store.getSimulationState(),
    ]);
    const agentsById = new Map(agents.map((a) => [a.id, a]));
    const ranked = rankMarket(
      services,
      agentsById,
      ctx.ranker,
      state.currentTick,
      q.kind && isServiceKind(q.kind) ? q.kind : undefined,
    );
    return ranked.flatMap(({ service, score }) => {
      const seller = agentsById.get(service.sellerAgentId);
      return seller ? [serviceListingDto(service, seller, score)] : [];
    });
  });

  app.get("/api/jobs", async (request) => {
    const q = parseWith(jobsQuery, request.query, "query");
    let status: JobStatus | undefined;
    if (q.status !== undefined) {
      if (!(JOB_STATUSES as readonly string[]).includes(q.status)) {
        throw notFound("job status", q.status);
      }
      status = q.status as JobStatus;
    }
    const [jobs, agents] = await Promise.all([
      ctx.readModel.listJobs(status),
      ctx.store.listAgents(),
    ]);
    const dto = dtoContext(ctx, agents);
    const out = [];
    for (const job of jobs) {
      const payment = job.paymentId === null ? null : await ctx.store.getPayment(job.paymentId);
      out.push(jobDto(job, dto, payment?.txHash ?? null));
    }
    return out;
  });

  app.get("/api/transactions", async (request) => {
    const q = parseWith(transactionsQuery, request.query, "query");
    const cursor = q.cursor === undefined ? undefined : decodePaymentsCursor(q.cursor);
    const [page, agents] = await Promise.all([
      ctx.readModel.listPayments({ limit: q.limit, ...(cursor ? { cursor } : {}) }),
      ctx.store.listAgents(),
    ]);
    const dto = dtoContext(ctx, agents);
    const last = page[page.length - 1];
    return {
      payments: page.map((p) => paymentDto(p, dto)),
      nextCursor: page.length === q.limit && last ? encodePaymentsCursor(last) : null,
    };
  });

  app.get("/api/events", async (request) => {
    const q = parseWith(eventsQuery, request.query, "query");
    const events = await ctx.readModel.eventsAfter(q.after ?? null, q.limit);
    const last = events[events.length - 1];
    return { events, nextCursor: last?.id ?? null };
  });

  app.get("/api/experiments", async () => {
    const [experiments, counts] = await Promise.all([
      ctx.readModel.listExperiments(),
      ctx.readModel.countAgentsByExperiment(),
    ]);
    return experiments.map((e) => experimentDto(e, counts.get(e.id) ?? 0));
  });

  app.get<{ Params: { id: string } }>("/api/experiments/:id", async (request) => {
    const experiment = await ctx.readModel.getExperiment(request.params.id);
    if (!experiment) throw notFound("experiment", request.params.id);
    const counts = await ctx.readModel.countAgentsByExperiment();
    return experimentDto(experiment, counts.get(experiment.id) ?? 0);
  });
}
