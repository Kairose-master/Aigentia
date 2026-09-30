import type { FastifyInstance } from "fastify";
import { X402_HEADERS } from "@aigentia/protocol";
import type { RouteContext } from "../context";

/**
 * POST /services/:id/invoke — the x402-protected seller endpoint advertised on every service
 * listing. Without PAYMENT-SIGNATURE it answers 402 with the payment requirements; with one it
 * verifies and settles on XRPL through the facilitator, then returns the service result and a
 * PAYMENT-RESPONSE header. All protocol logic lives in the engine's SellerGate.
 */
export function registerServiceRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post<{ Params: { id: string } }>("/services/:id/invoke", async (request, reply) => {
    const header = request.headers[X402_HEADERS.paymentSignature];
    const result = await ctx.runtime.sellerGate.handle({
      serviceId: request.params.id,
      body: request.body,
      paymentHeader: typeof header === "string" ? header : undefined,
      resourceUrl: `${ctx.env.API_PUBLIC_URL.replace(/\/+$/, "")}/services/${request.params.id}/invoke`,
    });
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    return reply.code(result.status).send(result.body);
  });
}
