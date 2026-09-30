import type { BalanceSnapshot } from "@aigentia/xrpl";

/** Where live balances come from: an xrpl BalanceReader (LedgerBalanceReader or MockLedger). */
export interface BalanceSource {
  getBalanceDrops(address: string): Promise<BalanceSnapshot>;
}

/** The world treasury: funds new agents and is the counterparty of world-market trades. */
export interface TreasuryInfo {
  readonly walletRef: string;
  readonly address: string;
}

/** Time source; injected so seeded simulations can run on a fixed clock. */
export type Clock = () => Date;
