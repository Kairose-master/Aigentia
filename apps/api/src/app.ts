import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { errorMessage } from "@aigentia/shared";
import { DEFAULT_SSE, defaultRanker, type RouteContext } from "./context";
import type { ApiDeps } from "./deps";
import { mapError, type ErrorBody } from "./errors";
import { WorldStoreReadModel } from "./read-model";
import { registerAdminRoutes } from "./routes/admin";
import { registerPublicRoutes } from "./routes/public";
import { registerServiceRoutes } from "./routes/services";
import { registerStreamRoute } from "./routes/stream";

/**
 * Safety net for the wire: DTO mappers already turn every bigint into a drops string, so a
 * bigint reaching the serializer is a programming error — but a spectator route must never
 * crash the process over it, so it is serialised as a string.
 */
export function serializeJson(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** Build the Fastify app. Tests inject an InMemoryWorldStore world; main.ts injects Postgres + Redis. */
export function buildApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    trustProxy: true,
  });

  const ctx: RouteContext = {
    env: deps.env,
    store: deps.store,
    events: deps.events,
    runtime: deps.runtime,
    readModel: deps.readModel ?? new WorldStoreReadModel(deps.store),
    logger: deps.logger,
    clock: deps.clock ?? (() => new Date()),
    ranker: defaultRanker(),
    sse: { ...DEFAULT_SSE, ...deps.sse },
    startedAt: (deps.clock ?? (() => new Date()))(),
    network: deps.runtime.ledger === "testnet" ? deps.env.XRPL_NETWORK : "mock",
    tickInProgress: false,
  };

  app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "x-admin-token", "payment-signature", "accept"],
    exposedHeaders: ["payment-response"],
  });

  app.setReplySerializer(serializeJson);

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      code: "NOT_FOUND",
      message: `route ${request.method} ${request.url} not found`,
    };
    void reply.code(404).send(body);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const mapped = mapError(error);
    if (mapped.unexpected) {
      deps.logger?.error(
        { err: error instanceof Error ? error : errorMessage(error), url: request.url },
        "request failed",
      );
    } else {
      deps.logger?.debug({ code: mapped.body.code, url: request.url }, mapped.body.message);
    }
    void reply.code(mapped.status).send(mapped.body);
  });

  registerPublicRoutes(app, ctx);
  registerStreamRoute(app, ctx);
  registerAdminRoutes(app, ctx);
  registerServiceRoutes(app, ctx);

  return app;
}
