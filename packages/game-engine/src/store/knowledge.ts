import { RESOURCE_TYPES, type ResourceType } from "@aigentia/shared";
import { KNOWLEDGE_CAP } from "../world";
import type { KnowledgeEntry } from "./types";

const RESOURCE_SET = new Set<string>(RESOURCE_TYPES);

/** Read the knowledge list out of an agent's strategy blob, ignoring anything malformed. */
export function knowledgeFromStrategy(strategy: Record<string, unknown>): KnowledgeEntry[] {
  const raw = strategy["knowledge"];
  if (!Array.isArray(raw)) return [];
  const out: KnowledgeEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const resourceType = r["resourceType"];
    const locationId = r["locationId"];
    const quantity = r["quantity"];
    const learnedAtTick = r["learnedAtTick"];
    if (
      typeof resourceType === "string" &&
      RESOURCE_SET.has(resourceType) &&
      typeof locationId === "string" &&
      typeof quantity === "number" &&
      Number.isInteger(quantity) &&
      typeof learnedAtTick === "number" &&
      Number.isInteger(learnedAtTick)
    ) {
      out.push({
        resourceType: resourceType as ResourceType,
        locationId,
        quantity,
        learnedAtTick,
      });
    }
  }
  return out;
}

/** Newest entry per (resourceType, locationId) wins; sorted newest first; bounded. */
export function mergeKnowledge(
  existing: readonly KnowledgeEntry[],
  incoming: readonly KnowledgeEntry[],
): KnowledgeEntry[] {
  const byKey = new Map<string, KnowledgeEntry>();
  for (const entry of [...existing, ...incoming]) {
    const key = `${entry.resourceType}@${entry.locationId}`;
    const prev = byKey.get(key);
    if (!prev || entry.learnedAtTick >= prev.learnedAtTick) byKey.set(key, entry);
  }
  return [...byKey.values()]
    .sort((a, b) => {
      if (a.learnedAtTick !== b.learnedAtTick) return b.learnedAtTick - a.learnedAtTick;
      const ka = `${a.resourceType}@${a.locationId}`;
      const kb = `${b.resourceType}@${b.locationId}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .slice(0, KNOWLEDGE_CAP);
}

/** Plain JSON copies for the strategy blob. */
export function knowledgeToJson(entries: readonly KnowledgeEntry[]): Record<string, unknown>[] {
  return entries.map((e) => ({
    resourceType: e.resourceType,
    locationId: e.locationId,
    quantity: e.quantity,
    learnedAtTick: e.learnedAtTick,
  }));
}
