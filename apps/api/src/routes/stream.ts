import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorldEvent } from "@aigentia/protocol";
import { errorMessage } from "@aigentia/shared";
import { computeStats, statsEnvelope, type RouteContext } from "../context";
import { SSE_HEADERS, formatSseEnvelope, sseComment, sseRetry } from "../sse";

/**
 * GET /api/events/stream — Server-Sent Events. Sends an initial "stats" envelope, then every
 * published WorldEvent as an "event" envelope, a fresh "stats" every 5s and a "heartbeat"
 * every 15s. All timers and the bus subscription are released when the client disconnects
 * or the server closes.
 */
export function registerStreamRoute(app: FastifyInstance, ctx: RouteContext): void {
  const open = new Set<() => void>();

  app.addHook("onClose", async () => {
    for (const close of [...open]) close();
  });

  app.get("/api/events/stream", (request: FastifyRequest, reply: FastifyReply) => {
    // Headers set by hooks (CORS) are not flushed after hijack(): copy them onto the raw response.
    const headers: OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[key] = typeof value === "number" ? String(value) : value;
    }
    Object.assign(headers, SSE_HEADERS);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, headers);
    raw.write(sseRetry(ctx.sse.retryMs));
    raw.write(sseComment("connected"));

    let closed = false;
    const send = (chunk: string): void => {
      if (closed || raw.destroyed || raw.writableEnded) return;
      raw.write(chunk);
    };

    const pushStats = async (): Promise<void> => {
      try {
        send(formatSseEnvelope(statsEnvelope(await computeStats(ctx))));
      } catch (e: unknown) {
        ctx.logger?.warn({ err: errorMessage(e) }, "sse: stats envelope failed");
      }
    };
    const pushHeartbeat = (): void => {
      send(formatSseEnvelope({ channel: "heartbeat", data: { at: ctx.clock().toISOString() } }));
    };
    const onEvent = (event: WorldEvent): void => {
      send(formatSseEnvelope({ channel: "event", data: event }, event.id));
    };

    const unsubscribe = ctx.events.subscribe(onEvent);
    const statsTimer = setInterval(() => void pushStats(), ctx.sse.statsIntervalMs);
    const heartbeatTimer = setInterval(pushHeartbeat, ctx.sse.heartbeatIntervalMs);

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(statsTimer);
      clearInterval(heartbeatTimer);
      unsubscribe();
      open.delete(close);
      if (!raw.writableEnded) raw.end();
    };
    open.add(close);
    request.raw.on("close", close);
    raw.on("close", close);
    raw.on("error", close);

    void pushStats();
  });
}
