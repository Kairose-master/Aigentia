import type { WorldEvent, WorldEventInput, WorldEventTypeName } from "@aigentia/protocol";
import type { WorldStore } from "./store/types";

/** Called after every event is persisted (SSE fan-out lives in the apps). */
export type EventSink = (event: WorldEvent) => Promise<void>;

export interface WorldEventParams {
  readonly tick: number;
  readonly type: WorldEventTypeName;
  readonly message: string;
  readonly at: Date;
  readonly agentId?: string | null;
  readonly counterpartyId?: string | null;
  readonly experimentId?: string | null;
  readonly txHash?: string | null;
  readonly amountDrops?: bigint | null;
  readonly payload?: Record<string, unknown>;
}

/** Build a WorldEventInput in the shape the store persists (drops as strings, ISO time). */
export function worldEvent(params: WorldEventParams): WorldEventInput {
  return {
    tick: params.tick,
    type: params.type,
    message: params.message.slice(0, 500),
    agentId: params.agentId ?? null,
    counterpartyId: params.counterpartyId ?? null,
    experimentId: params.experimentId ?? null,
    txHash: params.txHash ?? null,
    amountDrops:
      params.amountDrops === undefined || params.amountDrops === null
        ? null
        : params.amountDrops.toString(),
    payload: params.payload ?? {},
    createdAt: params.at.toISOString(),
  };
}

/** Persists events through the store, then hands each one to the sink and to subscribers. */
export class EventLog {
  private readonly listeners = new Set<(event: WorldEvent) => void>();

  constructor(
    private readonly store: WorldStore,
    private readonly sink?: EventSink,
  ) {}

  /** Synchronous in-process listener (the tick loop collects its own events this way). */
  subscribe(listener: (event: WorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(events: readonly WorldEventInput[]): Promise<WorldEvent[]> {
    if (events.length === 0) return [];
    const persisted = await this.store.appendEvents(events);
    for (const e of persisted) {
      for (const listener of this.listeners) listener(e);
      if (this.sink) await this.sink(e);
    }
    return persisted;
  }

  async emitOne(params: WorldEventParams): Promise<WorldEvent[]> {
    return this.emit([worldEvent(params)]);
  }
}
