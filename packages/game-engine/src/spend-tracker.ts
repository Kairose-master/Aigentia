import type { SpendTracker } from "@aigentia/economy";
import type { WorldStore } from "./store/types";

/**
 * SpendTracker backed by the payments table: every submitted or validated outgoing payment
 * row is the record, so `record()` is a no-op and `spentSince()` sums the store. This is
 * what production and the deterministic simulation use; InMemorySpendTracker stays for
 * unit tests that have no store.
 */
export class WorldStoreSpendTracker implements SpendTracker {
  constructor(private readonly store: WorldStore) {}

  async record(_agentId: string, _amountDrops: bigint, _at: Date): Promise<void> {
    // The payment row written by Settlement is the record.
  }

  spentSince(agentId: string, since: Date): Promise<bigint> {
    return this.store.sumSpentSince(agentId, since);
  }
}
