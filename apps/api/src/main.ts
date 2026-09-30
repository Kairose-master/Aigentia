import { createDb } from "@aigentia/db";
import { createRuntime } from "@aigentia/game-engine";
import { createLogger, errorMessage, loadEnv } from "@aigentia/shared";
import { buildApp } from "./app";
import { RedisEventBus } from "@aigentia/game-engine";
import { PostgresReadModel } from "./read-model";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger("api", env.LOG_LEVEL);

  const dbHandle = createDb(env.DATABASE_URL);
  const bus = new RedisEventBus(env.REDIS_URL, { logger });
  await bus.connect();

  const runtime = await createRuntime(env, {
    db: dbHandle.db,
    ledger: env.SIM_LEDGER,
    logger: logger.child({ name: "game-engine" }),
    eventSink: (event) => bus.publish(event),
  });
  await runtime.connect();

  const app = buildApp({
    env,
    store: runtime.store,
    events: bus,
    runtime,
    readModel: new PostgresReadModel(dbHandle.db),
    logger,
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "shutting down");
    const steps: [string, () => Promise<unknown>][] = [
      ["http", () => app.close()],
      ["xrpl", () => runtime.close()],
      ["redis", () => bus.close()],
      ["db", () => dbHandle.close()],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (e: unknown) {
        logger.warn({ err: errorMessage(e), step: name }, "shutdown step failed");
      }
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  const address = await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  logger.info(
    { address, ledger: runtime.ledger, network: runtime.xrplConfig?.name ?? "mock" },
    "api listening",
  );
  if (runtime.ledger === "mock") {
    logger.warn("[MOCK] SIM_LEDGER=mock: payments settle on the in-process MockLedger");
  }
}

main().catch((e: unknown) => {
  console.error(`api failed to start: ${errorMessage(e)}`);
  process.exit(1);
});
