import type { AgentBrain } from "@aigentia/agent-core";
import type { PaymentAdapter } from "@aigentia/economy";
import type { CreateAgentRequest } from "@aigentia/protocol";
import { envSchema, type Env, type Objective, type ServiceKind } from "@aigentia/shared";
import type { MockLedger } from "@aigentia/xrpl/testing";
import type { Clock } from "../context";
import { createRuntime, makeBrainFactory, type Runtime } from "../runtime";
import type { ServiceExecutor } from "../services";
import type { AgentRecord } from "../store/types";
import { InMemoryWorldStore } from "../store/in-memory";
import type { TickResult } from "../simulation";

export interface TestAgentSpec {
  readonly name: string;
  readonly objective: Objective;
  /** Starting capital funded by the treasury (0 → no funding payment). */
  readonly capitalXrp?: number;
  readonly services?: readonly { kind: ServiceKind; priceDrops: string }[];
  readonly budgetPolicy?: CreateAgentRequest["budgetPolicy"];
  readonly brain?: "deterministic" | "llm";
}

export interface BuildTestWorldOptions {
  readonly seed: string;
  readonly agents: readonly TestAgentSpec[];
  /** Brain per agent; defaults to the DeterministicAgent seeded with `seed`. */
  readonly brainFor?: (agent: AgentRecord) => AgentBrain | undefined;
  /** Wrap the MockPaymentAdapter (e.g. to force PAYMENT_FAILED). */
  readonly adapter?: (adapter: PaymentAdapter) => PaymentAdapter;
  /** Fault injection for service execution. */
  readonly executeService?: ServiceExecutor;
  /** Fixed-step clock start; defaults to 2026-01-01T00:00:00Z advancing one second per call. */
  readonly clockStart?: Date;
  readonly env?: Partial<Env>;
}

export interface TestWorld {
  readonly store: InMemoryWorldStore;
  readonly sim: Runtime["sim"];
  readonly ledger: MockLedger;
  readonly agents: AgentRecord[];
  readonly runtime: Runtime;
  readonly env: Env;
  /** Agent by (upper-cased) name. */
  agent(name: string): AgentRecord;
  runTicks(count: number): Promise<TickResult[]>;
}

/** A monotonic clock that advances a fixed step per call: deterministic timestamps. */
export function steppedClock(start = new Date("2026-01-01T00:00:00.000Z"), stepMs = 1000): Clock {
  let calls = 0;
  return () => {
    const at = new Date(start.getTime() + calls * stepMs);
    calls += 1;
    return at;
  };
}

/**
 * A complete Genesis Sector on InMemoryWorldStore + [MOCK] ledger, with the given agents
 * created and funded. Two worlds built with the same options behave identically.
 */
export async function buildTestWorld(options: BuildTestWorldOptions): Promise<TestWorld> {
  const env = envSchema.parse({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    SIM_LEDGER: "mock",
    SIM_SEED: options.seed,
    ...options.env,
  });
  const clock = steppedClock(options.clockStart);
  const store = new InMemoryWorldStore({ seed: options.seed, ledger: "mock", clock });
  const defaultBrainFor = makeBrainFactory(env);
  const custom = options.brainFor;
  const brainFor = (agent: AgentRecord): AgentBrain => custom?.(agent) ?? defaultBrainFor(agent);
  const runtime = await createRuntime(env, {
    ledger: "mock",
    store,
    clock,
    brainFor,
    ...(options.adapter ? { adapter: options.adapter } : {}),
    ...(options.executeService ? { executeService: options.executeService } : {}),
  });
  await runtime.connect();
  const ledger = runtime.mockLedger;
  if (!ledger) throw new Error("mock ledger missing");

  const agents: AgentRecord[] = [];
  for (const spec of options.agents) {
    agents.push(
      await runtime.createAgent({
        name: spec.name,
        objective: spec.objective,
        brain: spec.brain ?? "deterministic",
        startingCapitalXrp: spec.capitalXrp ?? 10,
        services: [...(spec.services ?? [])],
        ...(spec.budgetPolicy ? { budgetPolicy: spec.budgetPolicy } : {}),
      }),
    );
  }

  return {
    store,
    sim: runtime.sim,
    ledger,
    agents,
    runtime,
    env,
    agent(name: string): AgentRecord {
      const found = agents.find((a) => a.name === name.toUpperCase());
      if (!found) throw new Error(`no test agent named ${name}`);
      return found;
    },
    runTicks: (count: number) => runtime.sim.runTicks(count),
  };
}

export { steppedClock as testClock };
