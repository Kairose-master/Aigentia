import { fileURLToPath } from "node:url";
import { errorMessage, loadEnv, type Env, type Logger } from "@aigentia/shared";
import { Queue, Worker, type Job } from "bullmq";
import { createWorkerContainer, type WorkerContainer } from "./container";
import { indexLedger } from "./indexer";
import { rehydrateMockBalances } from "./mock-balances";
import { finishDueExperiments } from "@aigentia/game-engine";
import { runOneTick, type TickSummary } from "./tick-runner";

export const SIMULATION_QUEUE = "aigentia-simulation";
export const TICK_JOB = "tick";
export const INDEX_LEDGER_JOB = "index-ledger";
export const INDEX_LEDGER_EVERY_MS = 120_000;

type JobName = typeof TICK_JOB | typeof INDEX_LEDGER_JOB;
type JobData = Record<string, never>;
/** Job results must be JSON: summaries only, never the bigint-bearing TickResult. */
type JobResult =
  | { kind: "tick"; skipped: true; reason: "not_running" | "locked" }
  | { kind: "tick"; skipped: false; summary: TickSummary }
  | { kind: "index-ledger"; skipped: true; reason: "mock_ledger" }
  | { kind: "index-ledger"; skipped: false; addresses: number; fetched: number; inserted: number };

export interface WorkerProcess {
  readonly container: WorkerContainer;
  readonly queue: Queue<JobData, JobResult, JobName>;
  readonly worker: Worker<JobData, JobResult, JobName>;
  shutdown(): Promise<void>;
}

async function processJob(
  container: WorkerContainer,
  job: Job<JobData, JobResult, JobName>,
): Promise<JobResult> {
  if (job.name === TICK_JOB) {
    // [MOCK] agents created by the API since startup exist only in that process's ledger.
    await rehydrateMockBalances(container.runtime, container.store, container.logger);
    const outcome = await runOneTick(container);
    if (!outcome.skipped) {
      const finished = await finishDueExperiments(container.runtime);
      for (const e of finished)
        container.logger.info({ experimentId: e.id }, "experiment finished");
    }
    return outcome.skipped
      ? { kind: "tick", skipped: true, reason: outcome.reason }
      : { kind: "tick", skipped: false, summary: outcome.summary };
  }
  if (!container.indexer) {
    container.logger.debug("[MOCK] ledger indexing skipped on the mock ledger");
    return { kind: "index-ledger", skipped: true, reason: "mock_ledger" };
  }
  const indexed = await indexLedger({
    db: container.db,
    store: container.store,
    indexer: container.indexer,
    extraAddresses: [container.runtime.treasury.address],
    logger: container.logger,
  });
  return { kind: "index-ledger", skipped: false, ...indexed };
}

/** Wire the queue, the repeatable schedulers and the single-concurrency worker. */
export async function startWorker(env: Env, logger?: Logger): Promise<WorkerProcess> {
  const container = await createWorkerContainer(env, logger ? { logger } : {});
  const log = container.logger;
  await rehydrateMockBalances(container.runtime, container.store, log);

  const queue = new Queue<JobData, JobResult, JobName>(SIMULATION_QUEUE, {
    connection: container.redis,
  });
  const jobOpts = { removeOnComplete: 200, removeOnFail: 500 };
  await queue.upsertJobScheduler(
    TICK_JOB,
    { every: env.TICK_SECONDS * 1000 },
    { name: TICK_JOB, data: {}, opts: jobOpts },
  );
  await queue.upsertJobScheduler(
    INDEX_LEDGER_JOB,
    { every: INDEX_LEDGER_EVERY_MS },
    { name: INDEX_LEDGER_JOB, data: {}, opts: jobOpts },
  );

  const worker = new Worker<JobData, JobResult, JobName>(
    SIMULATION_QUEUE,
    (job) => processJob(container, job),
    {
      connection: container.redis,
      concurrency: 1,
      lockDuration: container.tickLockTtlMs,
    },
  );
  worker.on("failed", (job, error) => {
    log.error(
      { job: job?.name ?? null, jobId: job?.id ?? null, error: errorMessage(error) },
      "job failed",
    );
  });
  worker.on("error", (error) => log.error({ error: errorMessage(error) }, "worker error"));
  await worker.waitUntilReady();
  log.info(
    { queue: SIMULATION_QUEUE, tickMs: env.TICK_SECONDS * 1000, indexMs: INDEX_LEDGER_EVERY_MS },
    "worker started",
  );

  let closing: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        log.info("worker shutting down");
        await worker.close();
        await queue.close();
        await container.close();
      })();
    }
    return closing;
  };
  return { container, queue, worker, shutdown };
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isEntrypoint()) {
  const env = loadEnv();
  const proc = await startWorker(env);
  const stop = (signal: string): void => {
    proc.container.logger.info({ signal }, "signal received");
    proc
      .shutdown()
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        proc.container.logger.error({ error: errorMessage(e) }, "shutdown failed");
        process.exit(1);
      });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}
