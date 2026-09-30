import type { FastifyInstance } from "fastify";
import { notFound, type RouteContext } from "../context";
import type { ErrorBody } from "../errors";

/**
 * POST /services/:id/invoke — the x402-protected seller endpoint advertised on every
 * service listing. Registered now so the URL is stable; the 402 → PAYMENT-SIGNATURE →
 * 200 + PAYMENT-RESPONSE flow lands in Phase 3.
 */
export function registerServiceRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post<{ Params: { id: string } }>("/services/:id/invoke", async (request, reply) => {
    const service = await ctx.store.getService(request.params.id);
    if (!service) throw notFound("service", request.params.id);
    const body: ErrorBody = {
      code: "NOT_IMPLEMENTED",
      message: "x402 seller endpoint arrives in Phase 3",
      details: { serviceId: service.id, kind: service.kind },
    };
    return reply.code(501).send(body);
  });
}
