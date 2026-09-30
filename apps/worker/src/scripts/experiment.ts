/**
 * Create and start an experiment against the configured ledger, then exit; the running worker
 * drives the ticks and finishes it at its deadline (results appear on /experiments/[id]).
 *
 *   pnpm --filter @aigentia/worker experiment                      # Genesis 24H: 20 agents, 10 XRP, 24h
 *   pnpm --filter @aigentia/worker experiment --agents 4 --hours 0.25 --capital 2
 */
import { createExperiment, startExperiment } from "@aigentia/game-engine";
import { createLogger, errorMessage, loadEnv } from "@aigentia/shared";
import { createWorkerContainer } from "../container";
import { parseExperimentArgs } from "./experiment-args";

async function main(): Promise<void> {
  const env = loadEnv();
  const config = parseExperimentArgs(process.argv.slice(2));
  const logger = createLogger("experiment", env.LOG_LEVEL);
  const container = await createWorkerContainer(env, { logger });
  try {
    const rt = container.runtime;
    const deps = {
      ...rt,
      createAgent: (input: Parameters<typeof rt.createAgent>[0]) => rt.createAgent(input),
    };
    const draft = await createExperiment(deps, config, {
      defaultMinimumBalanceDrops: BigInt(env.POLICY_MINIMUM_BALANCE_DROPS),
    });
    console.log(
      `created ${draft.id} "${draft.name}" (${config.agentCount} agents, ${config.startingCapitalXrp} XRP each, ${config.durationHours}h, ledger=${rt.ledger})`,
    );
    const started = await startExperiment(deps, draft.id);
    console.log(
      `started; ends ${started.endsAt?.toISOString() ?? "?"}; human intervention disabled`,
    );
    console.log(`watch it on the dashboard at /experiments/${draft.id}`);
  } finally {
    await container.close();
  }
}

main().catch((e: unknown) => {
  console.error(`experiment failed: ${errorMessage(e)}`);
  process.exit(1);
});
