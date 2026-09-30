import type { SseEnvelope } from "@aigentia/protocol";

/**
 * Wire format of one Server-Sent Event. The `event:` field carries the envelope channel so
 * browsers can `addEventListener("event" | "stats" | "heartbeat")`, and `data:` carries the
 * whole envelope so `onmessage` consumers can switch on `channel` too.
 */
export function formatSseEnvelope(envelope: SseEnvelope, id?: number | string): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${envelope.channel}`);
  const json = JSON.stringify(envelope);
  for (const line of json.split(/\r?\n/)) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** A comment line keeps proxies from timing out and tells the client the retry delay. */
export function sseComment(text: string): string {
  return `: ${text.replace(/\r?\n/g, " ")}\n\n`;
}

export function sseRetry(ms: number): string {
  return `retry: ${Math.max(0, Math.floor(ms))}\n\n`;
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};
