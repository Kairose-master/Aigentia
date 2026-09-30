import type { ResourceType } from "@aigentia/shared";
import { AigentiaError } from "@aigentia/shared";
import type { AgentRecord, WorldStore } from "../store/types";

/**
 * Remove `quantity` of a resource from an agent's inventory, taking from the agent's own
 * location first and then from the others in id order. Throws INSUFFICIENT_FUNDS when the
 * agent does not hold enough overall (nothing is removed in that case).
 */
export async function consumeInventory(
  store: WorldStore,
  agent: Pick<AgentRecord, "id" | "locationId">,
  resourceType: ResourceType,
  quantity: number,
  nextId: () => string,
): Promise<void> {
  const lines = (await store.getInventory(agent.id))
    .filter((i) => i.resourceType === resourceType && i.quantity > 0)
    .sort((a, b) => {
      const ownA = a.locationId === agent.locationId ? 0 : 1;
      const ownB = b.locationId === agent.locationId ? 0 : 1;
      if (ownA !== ownB) return ownA - ownB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const held = lines.reduce((s, l) => s + l.quantity, 0);
  if (held < quantity) {
    throw new AigentiaError("INSUFFICIENT_FUNDS", "insufficient inventory", {
      resourceType,
      have: held,
      need: quantity,
    });
  }
  let remaining = quantity;
  for (const line of lines) {
    if (remaining <= 0) break;
    const take = Math.min(line.quantity, remaining);
    await store.adjustInventory(agent.id, resourceType, line.locationId, -take, nextId());
    remaining -= take;
  }
}
