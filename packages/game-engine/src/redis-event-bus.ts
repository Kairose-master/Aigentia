import { Redis } from "ioredis";
import { REDIS_EVENT_CHANNEL, type WorldEvent } from "@aigentia/protocol";
import { errorMessage, type Logger } from "@aigentia/shared";
import { decodeBusMessage, encodeBusMessage, type EventBus, type EventListener } from "./event-bus";

export interface RedisEventBusOptions {
  readonly channel?: string;
  readonly logger?: Logger;
}

/**
 * Cross-process event fan-out over Redis pub/sub. The worker publishes the events its ticks
 * persist, the API publishes its own (agent creation, admin ticks) and streams everything it
 * receives to SSE clients. A dedicated subscriber connection is used because a connection in
 * subscribe mode cannot issue other commands.
 */
export class RedisEventBus implements EventBus {
  readonly channel: string;
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Set<EventListener>();
  private readonly logger: Logger | undefined;
  private connected = false;

  constructor(url: string, options: RedisEventBusOptions = {}) {
    this.channel = options.channel ?? REDIS_EVENT_CHANNEL;
    this.logger = options.logger;
    this.publisher = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3, family: 0 });
    this.subscriber = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, family: 0 });
    this.subscriber.on("message", (channel: string, message: string) => {
      if (channel !== this.channel) return;
      this.dispatch(message);
    });
    for (const conn of [this.publisher, this.subscriber]) {
      conn.on("error", (e: unknown) => {
        this.logger?.warn({ err: errorMessage(e) }, "redis event bus connection error");
      });
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.publisher.connect();
    await this.subscriber.connect();
    await this.subscriber.subscribe(this.channel);
    this.connected = true;
  }

  async publish(event: WorldEvent): Promise<void> {
    await this.publisher.publish(this.channel, encodeBusMessage(event));
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    if (!this.connected) {
      this.publisher.disconnect();
      this.subscriber.disconnect();
      return;
    }
    this.connected = false;
    await Promise.allSettled([this.subscriber.quit(), this.publisher.quit()]);
  }

  private dispatch(message: string): void {
    const event = decodeBusMessage(message);
    if (!event) {
      this.logger?.warn("dropping malformed message on the event channel");
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e: unknown) {
        this.logger?.warn({ err: errorMessage(e) }, "event listener threw");
      }
    }
  }
}
