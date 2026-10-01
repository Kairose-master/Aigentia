import { createDb, type Database, type DbHandle } from "@aigentia/db";
import { createRuntime, PostgresWorldStore, type Runtime } from "@aigentia/game-engine";
import { createLogger, errorMessage, type Env, type Logger } from "@aigentia/shared";
import { LedgerTransactionIndexer, XRPLClient, type TransactionIndexer } from "@aigentia/xrpl";
import { Redis } from "ioredis";
import { RedisEventBus, type EventBus } from "@aigentia/game-engine";
import { RedisLock, type TickLock } from "./lock";

export interface WorkerContainerOptions {
  readonly logger?: Logger;
  /** Mock ledger only: XRP minted to the treasury at start (default 1,000,000 XRP). */
  readonly mockTreasuryXrp?: bigint;
  /** Skip `runtime.connect()` (tests); default true. */
  readonly connect?: boolean;
}

export interface WorkerContainer {
  readonly env: Env;
  readonly logger: Logger;
  readonly db: Database;
  readonly store: PostgresWorldStore;
  readonly runtime: Runtime;
  /** Publishes persisted events to REDIS_EVENT_CHANNEL for the API; the store is the record. */
  readonly events: EventBus;
  readonly redis: Redis;
  readonly lock: TickLock;
  /** Lock TTL for one tick: twice the tick period, at least two minutes. */
  readonly tickLockTtlMs: number;
  /**
   * Ledger transaction indexer for `ledger_transactions` — a dedicated XRPL client on testnet
   * (connected lazily), null on the mock ledger where there is nothing external to index.
   */
  readonly indexer: TransactionIndexer | null;
  close(): Promise<void>;
}

/** Lock TTL that comfortably covers one tick even with slow LLM brains. */
export function tickLockTtlMs(tickSeconds: number): number {
  return Math.max(2 * tickSeconds * 1000, 120_000);
}

/** BullMQ requires `maxRetriesPerRequest: null` on the connections it blocks on. */
export function createRedis(url: string, logger?: Logger): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    // Dual-stack DNS: Railway private networking (and others) may resolve to IPv6 only.
    family: 0,
  });
  redis.on("error", (e) => logger?.error({ error: errorMessage(e) }, "redis error"));
  return redis;
}

/**
 * Everything the worker process needs: Postgres store, engine runtime for env.SIM_LEDGER,
 * Redis (BullMQ connection, tick lock, event bus) and the ledger indexer.
 */
export async function createWorkerContainer(
  env: Env,
  options: WorkerContainerOptions = {},
): Promise<WorkerContainer> {
  const logger = options.logger ?? createLogger("worker", env.LOG_LEVEL);
  const handle: DbHandle = createDb(env.DATABASE_URL);
  const store = new PostgresWorldStore(handle.db);
  const events = new RedisEventBus(env.REDIS_URL, { logger });
  let runtime: Runtime;
  try {
    await events.connect();
    runtime = await createRuntime(env, {
      db: handle.db,
      store,
      ledger: env.SIM_LEDGER,
      logger,
      // Every persisted event is published exactly once, live, as the store records it.
      eventSink: (event) => events.publish(event),
      ...(options.mockTreasuryXrp !== undefined
        ? { mockTreasuryXrp: options.mockTreasuryXrp }
        : {}),
    });
    if (options.connect ?? true) await runtime.connect();
  } catch (e) {
    await events.close();
    await handle.close();
    throw e;
  }

  const redis = createRedis(env.REDIS_URL, logger);
  const lock = new RedisLock(redis);

  let indexerClient: XRPLClient | null = null;
  let indexer: TransactionIndexer | null = null;
  if (runtime.ledger === "testnet" && runtime.xrplConfig) {
    const client = new XRPLClient(runtime.xrplConfig, { logger });
    indexerClient = client;
    const inner = new LedgerTransactionIndexer(client);
    indexer = {
      async indexAddress(address, opts) {
        if (!client.isConnected()) {
          await client.connect();
          await client.assertNetwork();
        }
        return inner.indexAddress(address, opts);
      },
    };
  }

  logger.info(
    { ledger: runtime.ledger, treasury: runtime.treasury.address, tickSeconds: env.TICK_SECONDS },
    "worker container ready",
  );

  return {
    env,
    logger,
    db: handle.db,
    store,
    runtime,
    events,
    redis,
    lock,
    tickLockTtlMs: tickLockTtlMs(env.TICK_SECONDS),
    indexer,
    async close(): Promise<void> {
      const steps: (() => Promise<unknown>)[] = [
        () => events.close(),
        () => runtime.close(),
        () => (indexerClient ? indexerClient.disconnect() : Promise.resolve()),
        () => redis.quit(),
        () => handle.close(),
      ];
      for (const step of steps) {
        try {
          await step();
        } catch (e) {
          logger.warn({ error: errorMessage(e) }, "container close step failed");
        }
      }
    },
  };
}
