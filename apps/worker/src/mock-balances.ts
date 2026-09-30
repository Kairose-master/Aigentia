import type { AgentRecord, Runtime, WorldStore } from "@aigentia/game-engine";
import type { Logger } from "@aigentia/shared";

export interface RehydrateResult {
  readonly ledger: "mock";
  /** Agents whose cached balance was re-minted on the fresh MockLedger. */
  readonly funded: { agentId: string; name: string; balanceDrops: bigint }[];
  /**
   * Agents whose persisted wallet address is not what this process's MockWalletProvider
   * derives for their walletRef (created under another SIM_SEED): they cannot sign, so they
   * are left alone and any payment they attempt fails at the adapter.
   */
  readonly orphaned: { agentId: string; name: string }[];
}

/** Pure: which persisted agents need their cached balance re-minted on an empty mock account. */
export function agentsNeedingMockFunds(
  agents: readonly AgentRecord[],
  mockBalanceOf: (address: string) => bigint,
): AgentRecord[] {
  return agents.filter(
    (a) => a.status !== "retired" && a.balanceDrops > 0n && mockBalanceOf(a.walletAddress) === 0n,
  );
}

/**
 * [MOCK] The MockLedger lives in process memory while agents persist in Postgres. After a
 * restart every persisted agent would look broke, so on the mock ledger we re-mint each
 * agent's last cached balance. Never applies to testnet: returns null there.
 */
export async function rehydrateMockBalances(
  runtime: Pick<Runtime, "mockLedger" | "ledger" | "walletProvider">,
  store: Pick<WorldStore, "listAgents">,
  logger?: Logger,
): Promise<RehydrateResult | null> {
  const ledger = runtime.mockLedger;
  if (runtime.ledger !== "mock" || !ledger) return null;
  const agents = await store.listAgents();
  const balances = new Map<string, bigint>();
  const orphaned: RehydrateResult["orphaned"] = [];
  const signable: AgentRecord[] = [];
  for (const a of agents) {
    const derived = await runtime.walletProvider.getAddress(a.walletRef);
    if (derived !== a.walletAddress) {
      orphaned.push({ agentId: a.id, name: a.name });
      continue;
    }
    signable.push(a);
    balances.set(a.walletAddress, (await ledger.getBalanceDrops(a.walletAddress)).balanceDrops);
  }
  const funded: RehydrateResult["funded"] = [];
  for (const a of agentsNeedingMockFunds(signable, (addr) => balances.get(addr) ?? 0n)) {
    ledger.fund(a.walletAddress, a.balanceDrops);
    funded.push({ agentId: a.id, name: a.name, balanceDrops: a.balanceDrops });
  }
  if (funded.length > 0) {
    logger?.warn(
      { agents: funded.map((f) => f.name) },
      "[MOCK] re-minted cached balances on the in-process mock ledger",
    );
  }
  if (orphaned.length > 0) {
    logger?.warn(
      { agents: orphaned.map((o) => o.name) },
      "[MOCK] agents created under another SIM_SEED cannot sign on this mock ledger; left unfunded",
    );
  }
  return { ledger: "mock", funded, orphaned };
}
