import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createAgentRequestSchema, experimentConfigSchema } from "@aigentia/protocol";
import {
  createExperiment,
  finishExperiment,
  startExperiment,
  type ExperimentDeps,
} from "@aigentia/game-engine";
import { AigentiaError, errorMessage } from "@aigentia/shared";
import { summariseAgents, type RouteContext } from "../context";
import { experimentDto, simulationStateDto, tickSummaryDto } from "../dto";
import { parseWith } from "../query";

export const ADMIN_TOKEN_HEADER = "x-admin-token";

function sameToken(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Reject anything without the exact ADMIN_TOKEN in the X-Admin-Token header. */
export function requireAdminToken(expected: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers[ADMIN_TOKEN_HEADER];
    const given = Array.isArray(header) ? header[0] : header;
    if (typeof given !== "string" || given.length === 0 || !sameToken(given, expected)) {
      throw new AigentiaError("UNAUTHORIZED", "invalid or missing admin token");
    }
  };
}

/**
 * Experiments with humanInterventionAfterStart=false lock the world: while one runs, admin
 * actions that would steer the economy (new agents, pausing, manual ticks) are refused.
 */
async function assertNoLockedExperiment(ctx: RouteContext, action: string): Promise<void> {
  const running = await ctx.store.listExperiments({ status: "running" });
  const locked = running.find((e) => e.config.humanInterventionAfterStart === false);
  if (locked) {
    throw new AigentiaError(
      "CONFLICT",
      `human intervention is disabled while experiment "${locked.name}" runs (${action} refused)`,
      { experimentId: locked.id },
    );
  }
}

function experimentDeps(ctx: RouteContext): ExperimentDeps {
  const rt = ctx.runtime;
  return {
    store: ctx.store,
    ids: rt.ids,
    clock: rt.clock,
    events: rt.events,
    balances: rt.balances,
    createAgent: (input) => rt.createAgent(input),
  };
}

async function experimentBody(ctx: RouteContext, id: string) {
  const [experiment, counts] = await Promise.all([
    ctx.store.getExperiment(id),
    ctx.readModel.countAgentsByExperiment(),
  ]);
  if (!experiment) throw new AigentiaError("NOT_FOUND", `experiment ${id} not found`);
  return experimentDto(experiment, counts.get(id) ?? 0);
}

export function registerAdminRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.register(
    async (admin) => {
      admin.addHook("onRequest", requireAdminToken(ctx.env.ADMIN_TOKEN));

      admin.post("/agents", async (request, reply) => {
        await assertNoLockedExperiment(ctx, "creating agents");
        const body = parseWith(createAgentRequestSchema, request.body ?? {}, "agent request");
        const agent = await ctx.runtime.createAgent(body);
        const [summary] = await summariseAgents(ctx, [agent]);
        return reply.code(201).send(summary);
      });

      admin.post("/experiments", async (request, reply) => {
        const config = parseWith(experimentConfigSchema, request.body ?? {}, "experiment config");
        const experiment = await createExperiment(experimentDeps(ctx), config, {
          defaultMinimumBalanceDrops: BigInt(ctx.env.POLICY_MINIMUM_BALANCE_DROPS),
        });
        return reply.code(201).send(await experimentBody(ctx, experiment.id));
      });

      admin.post<{ Params: { id: string } }>("/experiments/:id/start", async (request) => {
        const started = await startExperiment(experimentDeps(ctx), request.params.id);
        ctx.logger?.info({ experimentId: started.id }, "experiment started");
        return experimentBody(ctx, started.id);
      });

      /** Ends the experiment now; before its deadline that is recorded as "aborted". */
      admin.post<{ Params: { id: string } }>("/experiments/:id/finish", async (request) => {
        const deps = experimentDeps(ctx);
        const current = await ctx.store.getExperiment(request.params.id);
        const early = current?.endsAt ? current.endsAt.getTime() > deps.clock().getTime() : false;
        const done = await finishExperiment(deps, request.params.id, {
          status: early ? "aborted" : "finished",
        });
        return experimentBody(ctx, done.id);
      });

      admin.post("/sim/start", async () => {
        await assertNoLockedExperiment(ctx, "starting the simulation");
        const state = await ctx.store.setSimulationState({ running: true });
        ctx.logger?.info({ tick: state.currentTick }, "simulation started");
        return simulationStateDto(state);
      });

      admin.post("/sim/stop", async () => {
        await assertNoLockedExperiment(ctx, "pausing the simulation");
        const state = await ctx.store.setSimulationState({ running: false });
        ctx.logger?.info({ tick: state.currentTick }, "simulation stopped");
        return simulationStateDto(state);
      });

      admin.post("/sim/tick", async () => {
        await assertNoLockedExperiment(ctx, "manual ticks");
        if (ctx.tickInProgress) {
          throw new AigentiaError("CONFLICT", "a tick is already running");
        }
        ctx.tickInProgress = true;
        try {
          const result = await ctx.runtime.sim.runTick();
          return tickSummaryDto(result);
        } catch (e: unknown) {
          ctx.logger?.error({ err: errorMessage(e) }, "admin tick failed");
          throw e;
        } finally {
          ctx.tickInProgress = false;
        }
      });
    },
    { prefix: "/api/admin" },
  );
}
