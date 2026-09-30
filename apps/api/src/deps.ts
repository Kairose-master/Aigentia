import type {
  AgentRecord,
  CreateAgentInput,
  Simulation,
  TreasuryInfo,
  WorldStore,
  SellerGate,
} from "@aigentia/game-engine";
import type { Env, Logger } from "@aigentia/shared";
import type { XrplNetworkConfig } from "@aigentia/xrpl";
import type { EventBus } from "@aigentia/game-engine";
import type { ReadModel } from "./read-model";

/** The slice of a game-engine `Runtime` the API needs (a Runtime satisfies it as-is). */
export interface ApiRuntime {
  readonly ledger: "testnet" | "mock";
  readonly sim: Pick<Simulation, "runTick">;
  /** x402 resource server behind POST /services/:id/invoke. */
  readonly sellerGate: Pick<SellerGate, "handle">;
  readonly treasury: TreasuryInfo;
  readonly xrplConfig: XrplNetworkConfig | null;
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
}

export interface SseOptions {
  /** Interval of the "stats" envelope (default 5s). */
  readonly statsIntervalMs?: number;
  /** Interval of the "heartbeat" envelope (default 15s). */
  readonly heartbeatIntervalMs?: number;
  /** Reconnect delay advertised to browsers (default 3s). */
  readonly retryMs?: number;
}

export interface ApiDeps {
  readonly env: Env;
  readonly store: WorldStore;
  /** Fan-out of persisted events to SSE clients (RedisEventBus in production). */
  readonly events: EventBus;
  readonly runtime: ApiRuntime;
  /** Global queries; defaults to `WorldStoreReadModel(store)`. */
  readonly readModel?: ReadModel;
  readonly logger?: Logger;
  readonly clock?: () => Date;
  readonly sse?: SseOptions;
}
