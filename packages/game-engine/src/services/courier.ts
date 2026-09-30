import { AigentiaError } from "@aigentia/shared";
import { courierInputSchema, courierOutputSchema, type CourierOutput } from "@aigentia/protocol";
import { locationDistance } from "../world";
import type { ServiceContext } from "./types";

/**
 * COURIER: moves `quantity` of the buyer's `resourceType` from one location to another.
 * Fails (VALIDATION_FAILED / INSUFFICIENT_FUNDS) when a location is unknown or the buyer
 * does not hold enough at the origin. Distance is euclidean between the two locations.
 */
export async function executeCourier(input: unknown, ctx: ServiceContext): Promise<CourierOutput> {
  const params = courierInputSchema.parse(input);
  const locations = await ctx.store.listLocations();
  const from = locations.find((l) => l.id === params.fromLocationId);
  const to = locations.find((l) => l.id === params.toLocationId);
  if (!from || !to) {
    throw new AigentiaError("VALIDATION_FAILED", "unknown location", {
      fromLocationId: params.fromLocationId,
      toLocationId: params.toLocationId,
    });
  }
  if (from.id === to.id) {
    throw new AigentiaError("VALIDATION_FAILED", "origin and destination are the same location", {
      locationId: from.id,
    });
  }
  const inventory = await ctx.store.getInventory(ctx.buyerAgentId);
  const held =
    inventory.find((i) => i.resourceType === params.resourceType && i.locationId === from.id)
      ?.quantity ?? 0;
  if (held < params.quantity) {
    throw new AigentiaError("INSUFFICIENT_FUNDS", "insufficient inventory at origin", {
      resourceType: params.resourceType,
      locationId: from.id,
      have: held,
      need: params.quantity,
    });
  }
  await ctx.store.transaction(async (tx) => {
    await tx.adjustInventory(
      ctx.buyerAgentId,
      params.resourceType,
      from.id,
      -params.quantity,
      ctx.nextInventoryId(),
    );
    await tx.adjustInventory(
      ctx.buyerAgentId,
      params.resourceType,
      to.id,
      params.quantity,
      ctx.nextInventoryId(),
    );
  });
  return courierOutputSchema.parse({
    tick: ctx.tick,
    moved: {
      resourceType: params.resourceType,
      quantity: params.quantity,
      fromLocationId: from.id,
      toLocationId: to.id,
    },
    distance: Math.round(locationDistance(from, to) * 1000) / 1000,
  });
}
