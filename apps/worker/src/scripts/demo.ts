/**
 * Acceptance-test driver: seed the world, create ORION-7 (buyer) and ATLAS-3 (SCOUT seller)
 * if absent, switch the simulation on and run N ticks in-process (no queue), then print the
 * event log, both agents' balances / net worth and every payment with its tx hash.
 *
 *   SIM_LEDGER=mock pnpm --filter @aigentia/worker demo --ticks 5
 *
 * Phase 3 routes the same script through x402 + XRPL Testnet (SIM_LEDGER=testnet).
 */
import type { PaymentRecord } from "@aigentia/game-engine";
import { fmtXrp } from "@aigentia/game-engine";
import type { WorldEvent } from "@aigentia/protocol";
import { createLogger, errorMessage, loadEnv } from "@aigentia/shared";
import { createWorkerContainer } from "../container";
import { rehydrateMockBalances } from "../mock-balances";
import { formatTickSummary, runOneTick } from "../tick-runner";
import { parseDemoArgs } from "./args";
import { DEMO_AGENTS, ensureDemoAgents } from "./demo-agents";
import { agentReport, formatAgentReport, formatEventLine, formatPaymentLine } from "./report";

const MOCK_TREASURY_XRP = 1_000n;

function heading(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);
}

async function main(): Promise<number> {
  const env = loadEnv();
  const { ticks } = parseDemoArgs(process.argv.slice(2));
  const logger = createLogger("demo", env.LOG_LEVEL === "info" ? "warn" : env.LOG_LEVEL);
  const container = await createWorkerContainer(env, {
    logger,
    mockTreasuryXrp: MOCK_TREASURY_XRP,
  });
  const { runtime, store } = container;
  const printed = new Set<number>();
  const print = (e: WorldEvent): void => {
    if (e.id !== undefined && printed.has(e.id)) return;
    if (e.id !== undefined) printed.add(e.id);
    console.log(formatEventLine(e));
  };

  try {
    heading(`Aigentia demo · ledger=${runtime.ledger} · seed=${env.SIM_SEED} · ticks=${ticks}`);
    const treasury = await runtime.balances.getBalanceDrops(runtime.treasury.address);
    console.log(
      `treasury ${runtime.treasury.address} balance ${fmtXrp(treasury.balanceDrops)}` +
        (runtime.ledger === "mock" ? ` [MOCK, minted ${MOCK_TREASURY_XRP} XRP]` : ""),
    );
    const rehydrated = await rehydrateMockBalances(runtime, store, logger);
    for (const f of rehydrated?.funded ?? []) {
      console.log(`[MOCK] re-minted ${fmtXrp(f.balanceDrops)} for ${f.name}`);
    }

    heading("Agents");
    const unsubscribe = runtime.events.subscribe(print);
    const ensured = await ensureDemoAgents(runtime, store, DEMO_AGENTS, logger);
    unsubscribe();
    for (const a of ensured.agents) {
      console.log(
        `${ensured.created.includes(a.name) ? "created" : "exists "} ${a.name.padEnd(10)} ${a.id} ${a.walletAddress} objective=${a.objective}`,
      );
    }
    if (ensured.agents.length !== DEMO_AGENTS.length) {
      throw new Error(`expected ${DEMO_AGENTS.length} demo agents, found ${ensured.agents.length}`);
    }

    await store.setSimulationState({ running: true });

    heading("Event log");
    let ran = 0;
    for (let i = 0; i < ticks; i++) {
      const outcome = await runOneTick(container);
      if (outcome.skipped) {
        console.log(`tick skipped: ${outcome.reason}`);
        if (outcome.reason === "locked") {
          console.log("another worker holds the tick lock; stop it or wait for the lock to expire");
        }
        break;
      }
      for (const e of outcome.result.events) print(e);
      console.log(`   ${formatTickSummary(outcome.summary)}`);
      ran += 1;
    }

    heading("Balances & net worth");
    const prices = await store.getMarketPrices();
    const names = new Map((await store.listAgents()).map((a) => [a.id, a.name] as const));
    const addresses = new Map([[runtime.treasury.address, "TREASURY"]]);
    const payments = new Map<string, PaymentRecord>();
    for (const created of ensured.agents) {
      const agent = (await store.getAgent(created.id)) ?? created;
      const balance = await runtime.balances.getBalanceDrops(agent.walletAddress);
      const report = agentReport({
        agent,
        balance,
        inventory: await store.getInventory(agent.id),
        prices,
      });
      console.log(formatAgentReport(report));
      for (const p of await store.listPaymentsForAgent(agent.id, 500)) payments.set(p.id, p);
    }

    heading("Payments");
    const explorerBase = runtime.ledger === "testnet" ? env.XRPL_EXPLORER_URL : null;
    const sorted = [...payments.values()].sort(
      (a, b) => a.tick - b.tick || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    if (sorted.length === 0) console.log("no payments recorded");
    for (const p of sorted) {
      console.log(formatPaymentLine(p, { names, addresses, explorerBase }));
    }
    const validated = sorted.filter((p) => p.status === "validated");
    const volume = validated.reduce((sum, p) => sum + p.amountDrops, 0n);
    console.log(
      `\n${sorted.length} payments · ${validated.length} validated · volume ${fmtXrp(volume)} · ticks run ${ran}/${ticks}`,
    );
    return 0;
  } finally {
    await container.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(`demo failed: ${errorMessage(e)}`);
    if (e instanceof Error && e.stack) console.error(e.stack);
    process.exit(1);
  });
