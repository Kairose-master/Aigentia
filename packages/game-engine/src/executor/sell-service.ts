import { SERVICE_KIND_CATEGORY, parseDrops, type ServiceKind } from "@aigentia/shared";
import { serviceJsonSchemas, type WorldEventInput } from "@aigentia/protocol";
import { worldEvent } from "../events";
import type { IdGenerator } from "../ids";
import type { AgentRecord, ServiceRecord, WorldStore } from "../store/types";
import { fmtXrp } from "../world";
import { success, type ActionHandler } from "./types";

const DEFAULT_DESCRIPTIONS = {
  SCOUT: "Reports resource deposits, quantities and base prices across the sector.",
  ANALYST: "Market trend, volatility and buy/sell/hold recommendations per resource.",
  COURIER: "Moves your inventory between locations.",
} as const;

function article(word: string): string {
  return /^[AEIOU]/i.test(word) ? "an" : "a";
}

/** Public x402 endpoint a service is advertised under. */
export function serviceEndpoint(apiPublicUrl: string, serviceId: string): string {
  return `${apiPublicUrl.replace(/\/+$/, "")}/services/${serviceId}/invoke`;
}

export interface ListServiceParams {
  readonly store: WorldStore;
  readonly agent: Pick<AgentRecord, "id" | "name">;
  readonly kind: ServiceKind;
  readonly priceDrops: bigint;
  readonly description?: string;
  readonly ids: IdGenerator;
  readonly apiPublicUrl: string;
  readonly tick: number;
  readonly now: Date;
}

export interface ListServiceResult {
  readonly service: ServiceRecord;
  readonly created: boolean;
  readonly event: WorldEventInput;
}

/**
 * Register (or re-price) an agent's service of a kind: name "{AGENT}-{KIND}", endpoint under
 * the public API, JSON schemas from the protocol. Shared by SELL_SERVICE and agent creation.
 */
export async function listAgentService(params: ListServiceParams): Promise<ListServiceResult> {
  const { store, agent, kind } = params;
  const existing = (await store.listServices({ sellerAgentId: agent.id, kind }))[0];
  const id = existing?.id ?? params.ids.next("service", `${agent.id}:${kind}`);
  const schemas = serviceJsonSchemas(kind);
  const service = await store.upsertService({
    id,
    sellerAgentId: agent.id,
    kind,
    name: `${agent.name.toUpperCase()}-${kind}`,
    description: params.description ?? DEFAULT_DESCRIPTIONS[kind],
    endpoint: serviceEndpoint(params.apiPublicUrl, id),
    priceDrops: params.priceDrops,
    inputSchema: schemas.inputSchema,
    outputSchema: schemas.outputSchema,
    createdAt: params.now,
  });
  const category = SERVICE_KIND_CATEGORY[kind];
  const message = existing
    ? `${agent.name} re-priced its ${kind} ${category} service to ${fmtXrp(params.priceDrops)}`
    : `${agent.name} listed ${article(kind)} ${kind} ${category} service at ${fmtXrp(params.priceDrops)}`;
  return {
    service,
    created: existing === undefined,
    event: worldEvent({
      tick: params.tick,
      at: params.now,
      type: "SERVICE_LISTED",
      agentId: agent.id,
      amountDrops: params.priceDrops,
      message,
      payload: { serviceId: service.id, kind, endpoint: service.endpoint },
    }),
  };
}

/** SELL_SERVICE: one service per kind per agent — a second listing re-prices the first. */
export const executeSellService: ActionHandler<"SELL_SERVICE"> = async (action, ctx) => {
  const price = parseDrops(action.priceDrops);
  const listed = await listAgentService({
    store: ctx.store,
    agent: ctx.agent,
    kind: action.kind,
    priceDrops: price,
    ...(action.description !== undefined ? { description: action.description } : {}),
    ids: ctx.ids,
    apiPublicUrl: ctx.apiPublicUrl,
    tick: ctx.tick,
    now: ctx.now,
  });
  return success(
    listed.created
      ? `Listed ${action.kind} at ${fmtXrp(price)}.`
      : `Re-priced ${action.kind} to ${fmtXrp(price)}.`,
    { events: [listed.event] },
  );
};
