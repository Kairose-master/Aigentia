import type { WorldStore } from "../store/types";

/** What a service implementation gets to see: the store and who is involved. */
export interface ServiceContext {
  readonly store: WorldStore;
  readonly tick: number;
  readonly sellerAgentId: string;
  readonly buyerAgentId: string;
  /** Names a new inventory line when COURIER has to create one. */
  readonly nextInventoryId: () => string;
}
