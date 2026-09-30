export interface InventoryLine {
  readonly resourceType: string;
  readonly quantity: number;
}

export interface NetWorthInput {
  readonly balanceDrops: bigint;
  readonly inventory: readonly InventoryLine[];
  /** Current market bids per resource type; unpriced resources are valued at zero. */
  readonly marketPrices: Readonly<Record<string, { readonly bidDrops: bigint }>>;
}

/** Balance plus inventory liquidated at the market bid. Never below the balance itself. */
export function computeNetWorthDrops(input: NetWorthInput): bigint {
  let total = input.balanceDrops;
  for (const line of input.inventory) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) continue;
    const price = input.marketPrices[line.resourceType];
    if (!price || price.bidDrops <= 0n) continue;
    total += price.bidDrops * BigInt(line.quantity);
  }
  return total;
}
