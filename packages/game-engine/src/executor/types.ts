import type { AgentAction, WorldEventInput } from "@aigentia/protocol";
import type { BalanceSnapshot } from "@aigentia/xrpl";
import type { TreasuryInfo } from "../context";
import type { EventLog } from "../events";
import type { IdGenerator } from "../ids";
import type { ServicePurchaser, Settlement } from "../settlement";
import type { AgentRecord, WorldStore } from "../store/types";

/** Everything a handler needs for one agent's action in one tick. */
export interface ExecutionContext {
  readonly agent: AgentRecord;
  readonly tick: number;
  readonly now: Date;
  /** Decision trace id the action belongs to (actionRef for transfers). */
  readonly decisionId: string;
  /** Id scope for everything created while executing: `${tick}:${agentId}`. */
  readonly scope: string;
  readonly store: WorldStore;
  readonly settlement: Settlement;
  readonly purchaser: ServicePurchaser;
  readonly events: EventLog;
  readonly ids: IdGenerator;
  /** Live balance from the observation step. */
  readonly balance: BalanceSnapshot;
  readonly apiPublicUrl: string;
  readonly treasury: TreasuryInfo;
}

export interface ExecutionResult {
  readonly status: "success" | "failed" | "rejected";
  /** Spectator-safe sentence stored on the decision trace. */
  readonly outcome: string;
  /** What the agent paid (drops), when money left its wallet. */
  readonly costDrops?: bigint;
  readonly paymentId?: string;
  readonly txHash?: string;
  /** Events the simulation appends after recording the decision. */
  readonly events: WorldEventInput[];
}

export type ActionOf<T extends AgentAction["type"]> = Extract<AgentAction, { type: T }>;

export type ActionHandler<T extends AgentAction["type"]> = (
  action: ActionOf<T>,
  ctx: ExecutionContext,
) => Promise<ExecutionResult>;

export const success = (
  outcome: string,
  extra: Omit<Partial<ExecutionResult>, "status" | "outcome"> = {},
): ExecutionResult => ({ status: "success", outcome, events: [], ...extra });

export const failed = (
  outcome: string,
  extra: Omit<Partial<ExecutionResult>, "status" | "outcome"> = {},
): ExecutionResult => ({ status: "failed", outcome, events: [], ...extra });

export const rejected = (
  outcome: string,
  extra: Omit<Partial<ExecutionResult>, "status" | "outcome"> = {},
): ExecutionResult => ({ status: "rejected", outcome, events: [], ...extra });
