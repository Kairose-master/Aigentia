import { xrpToDrops } from "@aigentia/shared";
import type { AccountInfoResponse, ServerInfoResponse } from "xrpl";
import { rippledErrorCode } from "./client";
import type { BalanceReader, BalanceSnapshot, XrplRequestClient } from "./types";

const ZERO: BalanceSnapshot = { balanceDrops: 0n, reserveDrops: 0n, spendableDrops: 0n };

/** Reads validated XRP balances and computes the account reserve from server_info. */
export class LedgerBalanceReader implements BalanceReader {
  constructor(private readonly client: XrplRequestClient) {}

  async getBalanceDrops(address: string): Promise<BalanceSnapshot> {
    let info: AccountInfoResponse;
    try {
      info = await this.client.request<AccountInfoResponse>({
        command: "account_info",
        account: address,
        ledger_index: "validated",
      });
    } catch (e) {
      if (rippledErrorCode(e) === "actNotFound") return ZERO;
      throw e;
    }
    const data = info.result.account_data;
    const balanceDrops = BigInt(data.Balance);
    const { baseDrops, incDrops } = await this.reserves();
    const reserveDrops = baseDrops + incDrops * BigInt(data.OwnerCount);
    const spendable = balanceDrops - reserveDrops;
    return { balanceDrops, reserveDrops, spendableDrops: spendable > 0n ? spendable : 0n };
  }

  private async reserves(): Promise<{ baseDrops: bigint; incDrops: bigint }> {
    const response = await this.client.request<ServerInfoResponse>({ command: "server_info" });
    const ledger = response.result.info.validated_ledger ?? response.result.info.closed_ledger;
    if (!ledger) return { baseDrops: 0n, incDrops: 0n };
    return {
      baseDrops: xrpToDrops(ledger.reserve_base_xrp),
      incDrops: xrpToDrops(ledger.reserve_inc_xrp),
    };
  }
}
