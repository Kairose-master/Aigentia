import { worldEventSchema, type WorldEvent } from "@aigentia/protocol";
import type { EventLog } from "./events";

export type EventListener = (event: WorldEvent) => void;

/**
 * Cross-process fan-out of persisted WorldEvents. The store is the record; the bus is only a
 * live notification channel (SSE spectators) and may drop messages when nobody listens.
 * Both apps wire it the same way: `createRuntime(env, { eventSink: (e) => bus.publish(e) })`
 * so every event is published exactly once, right after the store persisted it.
 */
export interface EventBus {
  publish(event: WorldEvent): Promise<void>;
  subscribe(listener: EventListener): () => void;
  close(): Promise<void>;
}

/** Wire format on the Redis channel: the WorldEvent itself, JSON encoded. */
export function encodeBusMessage(event: WorldEvent): string {
  return JSON.stringify(event);
}

/** Parse a message from the channel; `null` when it is not a valid WorldEvent. */
export function decodeBusMessage(raw: string): WorldEvent | null {
  try {
    const parsed = worldEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Same-process bus for tests and single-process demos. Listener errors never propagate. */
export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Set<EventListener>();
  readonly published: WorldEvent[] = [];

  async publish(event: WorldEvent): Promise<void> {
    this.published.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a failing spectator must never break the publisher
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}

/** Forward every event the engine's EventLog persists to a bus (single-process wiring). */
export function bridgeEventLog(events: EventLog, bus: EventBus): () => void {
  return events.subscribe((event) => {
    void bus.publish(event);
  });
}
