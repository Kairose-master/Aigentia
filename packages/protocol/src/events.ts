import { z } from "zod";
import { WORLD_EVENT_TYPES } from "@aigentia/shared";

/**
 * WorldEvents are the append-only narrative of the economy. They are persisted, streamed
 * over SSE to spectators and summarised into agent observations.
 */
export const worldEventTypeSchema = z.enum(WORLD_EVENT_TYPES);
export type WorldEventTypeName = z.infer<typeof worldEventTypeSchema>;

export const worldEventSchema = z.object({
  id: z.number().int().optional(),
  tick: z.number().int().min(0),
  type: worldEventTypeSchema,
  /** Human-readable line for the live feed, e.g. "ORION-7 paid ATLAS-3 for intelligence". */
  message: z.string().min(1).max(500),
  agentId: z.string().nullable().default(null),
  counterpartyId: z.string().nullable().default(null),
  experimentId: z.string().nullable().default(null),
  txHash: z.string().nullable().default(null),
  amountDrops: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type WorldEvent = z.infer<typeof worldEventSchema>;
export type WorldEventInput = z.input<typeof worldEventSchema>;

/** Envelope for Server-Sent Events. */
export const sseEnvelopeSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("event"), data: worldEventSchema }),
  z.object({
    channel: z.literal("stats"),
    data: z.object({
      agents: z.number().int(),
      transactions: z.number().int(),
      servicePurchases: z.number().int(),
      activeJobs: z.number().int(),
      volumeDrops: z.string(),
      tick: z.number().int(),
    }),
  }),
  z.object({ channel: z.literal("heartbeat"), data: z.object({ at: z.string() }) }),
]);
export type SseEnvelope = z.infer<typeof sseEnvelopeSchema>;

export const REDIS_EVENT_CHANNEL = "aigentia:events";
