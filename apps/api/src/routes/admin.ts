import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createAgentRequestSchema } from "@aigentia/protocol";
import { AigentiaError, errorMessage } from "@aigentia/shared";
import { summariseAgents, type RouteContext } from "../context";
import { simulationStateDto, tickSummaryDto } from "../dto";
import type { ErrorBody } from "../errors";
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

function notImplemented(reply: FastifyReply, message: string): FastifyReply {
  const body: ErrorBody = { code: "NOT_IMPLEMENTED", message };
  return reply.code(501).send(body);
}

export function registerAdminRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.register(
    async (admin) => {
      admin.addHook("onRequest", requireAdminToken(ctx.env.ADMIN_TOKEN));

      admin.post("/agents", async (request, reply) => {
        const body = parseWith(createAgentRequestSchema, request.body ?? {}, "agent request");
        const agent = await ctx.runtime.createAgent(body);
        const [summary] = await summariseAgents(ctx, [agent]);
        return reply.code(201).send(summary);
      });

      admin.post("/experiments", async (_request, reply) =>
        notImplemented(reply, "experiment creation arrives in Phase 5"),
      );
      admin.post("/experiments/:id/start", async (_request, reply) =>
        notImplemented(reply, "experiment start arrives in Phase 5"),
      );
      admin.post("/experiments/:id/finish", async (_request, reply) =>
        notImplemented(reply, "experiment finish arrives in Phase 5"),
      );

      admin.post("/sim/start", async () => {
        const state = await ctx.store.setSimulationState({ running: true });
        ctx.logger?.info({ tick: state.currentTick }, "simulation started");
        return simulationStateDto(state);
      });

      admin.post("/sim/stop", async () => {
        const state = await ctx.store.setSimulationState({ running: false });
        ctx.logger?.info({ tick: state.currentTick }, "simulation stopped");
        return simulationStateDto(state);
      });

      admin.post("/sim/tick", async () => {
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
