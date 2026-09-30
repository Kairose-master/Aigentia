import {
  createPaymentIntent,
  defaultBudgetPolicy,
  mergeBudgetPolicy,
  type PolicyEnv,
} from "@aigentia/economy";
import { createAgentRequestSchema, type CreateAgentRequest } from "@aigentia/protocol";
import { AigentiaError, xrpToDrops, type BrainKind } from "@aigentia/shared";
import type { WalletProvider } from "@aigentia/xrpl";
import type { Clock, TreasuryInfo } from "./context";
import type { EventLog } from "./events";
import { listAgentService } from "./executor";
import type { IdGenerator } from "./ids";
import { treasuryPayer, type Settlement } from "./settlement";
import type { AgentRecord, WorldStore } from "./store/types";
import { GENESIS_LOCATION_ID, fmtXrp } from "./world";

export interface CreateAgentDeps {
  readonly walletProvider: WalletProvider;
  readonly settlement: Settlement;
  readonly events: EventLog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly treasury: TreasuryInfo;
  readonly apiPublicUrl: string;
  readonly policyEnv: PolicyEnv;
  /** Model label stored on llm agents, e.g. "anthropic/claude-sonnet-5-5". */
  readonly defaultBrainModel?: string | null;
}

export type CreateAgentInput = CreateAgentRequest & {
  readonly experimentId?: string | null;
  /** Override for reproducible worlds; defaults to a seeded id derived from the name. */
  readonly id?: string;
  readonly brainModel?: string | null;
};

/**
 * Create an agent: wallet (walletRef = agent id), row with the default budget policy merged
 * with overrides, starting capital funded by the treasury through Settlement (a verified
 * ledger payment, purpose "funding"), requested services, AGENT_CREATED event.
 */
export async function createAgent(
  store: WorldStore,
  deps: CreateAgentDeps,
  input: CreateAgentInput,
): Promise<AgentRecord> {
  const request = createAgentRequestSchema.parse(input);
  const name = request.name.toUpperCase();
  if (await store.getAgentByName(name)) {
    throw new AigentiaError("CONFLICT", `agent ${name} already exists`, { name });
  }
  const id = input.id ?? deps.ids.next("agent", `agent:${name}`);
  const now = deps.clock();
  const tick = (await store.getSimulationState()).currentTick;
  const { address } = await deps.walletProvider.ensureWallet(id);
  const budgetPolicy = mergeBudgetPolicy(
    defaultBudgetPolicy(deps.policyEnv),
    request.budgetPolicy ?? {},
  );
  const capital = xrpToDrops(request.startingCapitalXrp);
  const brain: BrainKind = request.brain;

  const inserted = await store.insertAgent({
    id,
    name,
    objective: request.objective,
    brain,
    brainModel: brain === "llm" ? (input.brainModel ?? deps.defaultBrainModel ?? null) : null,
    walletAddress: address,
    walletRef: id,
    balanceDrops: 0n,
    reputation: 50,
    strategy: { memory: {}, knowledge: [] },
    budgetPolicy,
    locationId: GENESIS_LOCATION_ID,
    experimentId: input.experimentId ?? null,
    startingCapitalDrops: capital,
    createdAt: now,
  });

  if (capital > 0n) {
    const treasury = treasuryPayer(deps.treasury);
    const intent = createPaymentIntent({
      id: deps.ids.next("intent", `create:${id}`),
      agentId: treasury.id,
      purpose: "funding",
      destinationAddress: address,
      destinationAgentId: id,
      amount: capital,
      actionRef: { kind: "agent", id },
      memo: `funding ${name}`.slice(0, 200),
      createdAt: now.toISOString(),
    });
    const outcome = await deps.settlement.pay(intent, {
      agent: treasury,
      tick,
      scope: `create:${id}`,
      description: "as starting capital",
    });
    if (outcome.status !== "validated") {
      await store.updateAgent(id, { status: "paused" });
      throw new AigentiaError(
        "PAYMENT_FAILED",
        `could not fund ${name}: ${outcome.error ?? outcome.status}`,
        {
          agentId: id,
          paymentId: outcome.paymentId,
          status: outcome.status,
        },
      );
    }
  }

  const serviceEvents = [];
  for (const s of request.services) {
    const listed = await listAgentService({
      store,
      agent: inserted,
      kind: s.kind,
      priceDrops: BigInt(s.priceDrops),
      ids: deps.ids,
      apiPublicUrl: deps.apiPublicUrl,
      tick,
      now,
    });
    serviceEvents.push(listed.event);
  }

  await deps.events.emit([
    {
      tick,
      type: "AGENT_CREATED",
      message: `${name} joined the sector with ${fmtXrp(capital)} (objective: ${request.objective.replace(/_/g, " ")})`,
      agentId: id,
      amountDrops: capital.toString(),
      payload: {
        objective: request.objective,
        brain,
        services: request.services.map((s) => s.kind),
      },
      createdAt: now.toISOString(),
    },
    ...serviceEvents,
  ]);

  const final = await store.getAgent(id);
  if (!final) throw new AigentiaError("INTERNAL", `agent ${id} vanished after creation`);
  return final;
}
