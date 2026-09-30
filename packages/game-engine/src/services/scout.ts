import { scoutInputSchema, scoutOutputSchema, type ScoutOutput } from "@aigentia/protocol";
import type { KnowledgeEntry } from "../store/types";
import type { ServiceContext } from "./types";

/**
 * SCOUT: reports resource deposits (optionally filtered by resource type and/or location)
 * with their quantities and base prices, and stores the sightings as the buyer's knowledge.
 */
export async function executeScout(input: unknown, ctx: ServiceContext): Promise<ScoutOutput> {
  const params = scoutInputSchema.parse(input);
  const [resources, locations] = await Promise.all([
    ctx.store.listResources(),
    ctx.store.listLocations(),
  ]);
  const names = new Map(locations.map((l) => [l.id, l.name]));
  const sightings = resources
    .filter(
      (r) =>
        (params.resourceType === undefined || r.resourceType === params.resourceType) &&
        (params.locationId === undefined || r.locationId === params.locationId),
    )
    .sort((a, b) => {
      const ka = `${a.locationId}:${a.resourceType}`;
      const kb = `${b.locationId}:${b.resourceType}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .map((r) => ({
      resourceType: r.resourceType,
      locationId: r.locationId,
      locationName: names.get(r.locationId) ?? r.locationId,
      quantity: r.quantity,
      basePriceDrops: r.basePriceDrops.toString(),
    }));

  const knowledge: KnowledgeEntry[] = sightings.map((s) => ({
    resourceType: s.resourceType,
    locationId: s.locationId,
    quantity: s.quantity,
    learnedAtTick: ctx.tick,
  }));
  if (knowledge.length > 0) await ctx.store.addKnowledge(ctx.buyerAgentId, knowledge);

  return scoutOutputSchema.parse({ tick: ctx.tick, sightings });
}
