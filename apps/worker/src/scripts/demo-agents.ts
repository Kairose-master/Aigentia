import type { AgentRecord, Runtime, WorldStore } from "@aigentia/game-engine";
import type { CreateAgentRequest } from "@aigentia/protocol";
import type { Logger } from "@aigentia/shared";

export type DemoAgentSpec = CreateAgentRequest;

/** The acceptance-test cast: a buyer maximising net worth and a seller of SCOUT intel. */
export const DEMO_AGENTS: readonly DemoAgentSpec[] = [
  {
    name: "ORION-7",
    objective: "maximize_net_worth",
    brain: "deterministic",
    startingCapitalXrp: 10,
    services: [],
  },
  {
    name: "ATLAS-3",
    objective: "profitable_service",
    brain: "deterministic",
    startingCapitalXrp: 10,
    services: [{ kind: "SCOUT", priceDrops: "1000" }],
  },
];

/** Pure and idempotent: the specs whose (upper-cased) name is not among `existing`. */
export function missingDemoAgents(
  existing: readonly { name: string }[],
  specs: readonly DemoAgentSpec[] = DEMO_AGENTS,
): DemoAgentSpec[] {
  const names = new Set(existing.map((a) => a.name.toUpperCase()));
  return specs.filter((s) => !names.has(s.name.toUpperCase()));
}

export interface EnsureDemoAgentsResult {
  readonly agents: AgentRecord[];
  readonly created: string[];
}

/** Create the demo agents that do not exist yet; running twice creates nothing the second time. */
export async function ensureDemoAgents(
  runtime: Pick<Runtime, "createAgent">,
  store: Pick<WorldStore, "listAgents" | "getAgentByName">,
  specs: readonly DemoAgentSpec[] = DEMO_AGENTS,
  logger?: Logger,
): Promise<EnsureDemoAgentsResult> {
  const created: string[] = [];
  for (const spec of missingDemoAgents(await store.listAgents(), specs)) {
    const agent = await runtime.createAgent(spec);
    created.push(agent.name);
    logger?.info({ agent: agent.name, id: agent.id }, "demo agent created");
  }
  const agents: AgentRecord[] = [];
  for (const spec of specs) {
    const found = await store.getAgentByName(spec.name.toUpperCase());
    if (found) agents.push(found);
  }
  return { agents, created };
}
