import { computeNetWorthDrops } from "@aigentia/economy";
import { fmtXrp } from "@aigentia/game-engine";
import type {
  AgentRecord,
  InventoryItemRecord,
  MarketPriceRecord,
  PaymentRecord,
} from "@aigentia/game-engine";
import type { WorldEvent } from "@aigentia/protocol";
import type { BalanceSnapshot } from "@aigentia/xrpl";
import { explorerTxUrl } from "@aigentia/xrpl";

/** Pure: `[t3] PAYMENT_VALIDATED  ORION-7 paid ATLAS-3 … (0.001 XRP) tx=ABCD…` */
export function formatEventLine(e: WorldEvent): string {
  const parts = [`[t${e.tick}]`, e.type.padEnd(18), e.message];
  if (e.amountDrops) parts.push(`(${fmtXrp(BigInt(e.amountDrops))})`);
  if (e.txHash) parts.push(`tx=${e.txHash.slice(0, 12)}…`);
  return parts.join(" ");
}

export interface PaymentLineContext {
  /** Agent id → name for readable counterparties. */
  readonly names: ReadonlyMap<string, string>;
  /** Wallet address → name for parties without an agent row (the treasury). */
  readonly addresses?: ReadonlyMap<string, string>;
  /** Explorer base URL on testnet; null on the mock ledger (no explorer). */
  readonly explorerBase: string | null;
}

/** Pure: one payment with its tx hash and explorer link (or "[MOCK]" when there is none). */
export function formatPaymentLine(p: PaymentRecord, ctx: PaymentLineContext): string {
  const who = (agentId: string | null, address: string): string =>
    (agentId && ctx.names.get(agentId)) ?? ctx.addresses?.get(address) ?? agentId ?? address;
  const link =
    p.txHash === null
      ? "tx=none"
      : p.ledger === "mock" || ctx.explorerBase === null
        ? `tx=${p.txHash} [MOCK ledger, no explorer]`
        : `tx=${p.txHash} ${explorerTxUrl(ctx.explorerBase, p.txHash)}`;
  const parts = [
    `[t${p.tick}]`,
    p.kind.padEnd(10),
    p.status.padEnd(9),
    `${who(p.senderAgentId, p.senderAddress)} → ${who(p.receiverAgentId, p.receiverAddress)}`,
    fmtXrp(p.amountDrops),
    link,
  ];
  if (p.error) parts.push(`error=${p.error}`);
  return parts.join(" ");
}

export interface AgentReportInput {
  readonly agent: AgentRecord;
  readonly balance: BalanceSnapshot;
  readonly inventory: readonly InventoryItemRecord[];
  readonly prices: readonly MarketPriceRecord[];
}

export interface AgentReport {
  readonly name: string;
  readonly address: string;
  readonly status: AgentRecord["status"];
  readonly balanceDrops: bigint;
  readonly spendableDrops: bigint;
  readonly netWorthDrops: bigint;
  readonly reputation: number;
  readonly inventory: { resourceType: string; quantity: number }[];
}

/** Pure: an agent's balance and net worth (balance + inventory at bid). */
export function agentReport(input: AgentReportInput): AgentReport {
  const inventory = input.inventory
    .filter((i) => i.quantity > 0)
    .map((i) => ({ resourceType: i.resourceType, quantity: i.quantity }));
  const marketPrices: Record<string, { bidDrops: bigint }> = {};
  for (const p of input.prices) marketPrices[p.resourceType] = { bidDrops: p.bidDrops };
  return {
    name: input.agent.name,
    address: input.agent.walletAddress,
    status: input.agent.status,
    balanceDrops: input.balance.balanceDrops,
    spendableDrops: input.balance.spendableDrops,
    netWorthDrops: computeNetWorthDrops({
      balanceDrops: input.balance.balanceDrops,
      inventory,
      marketPrices,
    }),
    reputation: input.agent.reputation,
    inventory,
  };
}

export function formatAgentReport(r: AgentReport): string {
  const inv =
    r.inventory.length === 0
      ? "empty"
      : r.inventory.map((i) => `${i.resourceType}×${i.quantity}`).join(", ");
  return [
    `${r.name.padEnd(10)} ${r.address}`,
    `  status ${r.status} · balance ${fmtXrp(r.balanceDrops)} (spendable ${fmtXrp(r.spendableDrops)})`,
    `  net worth ${fmtXrp(r.netWorthDrops)} · reputation ${r.reputation} · inventory ${inv}`,
  ].join("\n");
}
