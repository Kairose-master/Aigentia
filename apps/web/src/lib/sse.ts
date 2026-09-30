import type { SseEnvelope, WorldEvent } from "@aigentia/protocol";

/**
 * Structural parsing of `SseEnvelope` messages on the client. The web app imports only
 * DTO *types* from @aigentia/protocol (no Zod in the browser bundle), so this is a
 * hand-written guard that fails closed: anything unexpected returns null.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function isWorldEvent(value: unknown): value is WorldEvent {
  if (!isRecord(value)) return false;
  return (
    isInt(value.tick) &&
    typeof value.type === "string" &&
    typeof value.message === "string" &&
    typeof value.createdAt === "string"
  );
}

/** Normalise a loosely shaped event (defaults applied like the Zod schema would). */
export function normalizeWorldEvent(value: unknown): WorldEvent | null {
  if (!isWorldEvent(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    id: isInt(raw.id) ? raw.id : undefined,
    tick: value.tick,
    type: value.type,
    message: value.message,
    agentId: nullableString(raw.agentId),
    counterpartyId: nullableString(raw.counterpartyId),
    experimentId: nullableString(raw.experimentId),
    txHash: nullableString(raw.txHash),
    amountDrops: nullableString(raw.amountDrops),
    payload: isRecord(raw.payload) ? raw.payload : {},
    createdAt: value.createdAt,
  };
}

/**
 * Parse one SSE `data:` payload. `fallbackChannel` is the SSE event name for servers
 * that use named events instead of an envelope `channel` field.
 */
export function parseSseEnvelope(raw: string, fallbackChannel?: string): SseEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const channel = typeof parsed.channel === "string" ? parsed.channel : fallbackChannel;
  const data = "data" in parsed && parsed.channel !== undefined ? parsed.data : parsed;
  switch (channel) {
    case "event": {
      const event = normalizeWorldEvent(data);
      return event ? { channel: "event", data: event } : null;
    }
    case "stats": {
      if (!isRecord(data)) return null;
      const { agents, transactions, servicePurchases, activeJobs, volumeDrops, tick } = data;
      if (
        !isInt(agents) ||
        !isInt(transactions) ||
        !isInt(servicePurchases) ||
        !isInt(activeJobs) ||
        typeof volumeDrops !== "string" ||
        !isInt(tick)
      ) {
        return null;
      }
      return {
        channel: "stats",
        data: { agents, transactions, servicePurchases, activeJobs, volumeDrops, tick },
      };
    }
    case "heartbeat": {
      const at = isRecord(data) && typeof data.at === "string" ? data.at : new Date().toISOString();
      return { channel: "heartbeat", data: { at } };
    }
    default:
      return null;
  }
}

/** Stable key for de-duplicating events that may arrive both from the seed page and the stream. */
export function eventKey(event: WorldEvent): string {
  if (event.id !== undefined) return `id:${event.id}`;
  return `t:${event.tick}:${event.type}:${event.createdAt}:${event.message}`;
}
