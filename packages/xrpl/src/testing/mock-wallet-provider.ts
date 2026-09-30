import { createHash } from "node:crypto";
import { Wallet } from "xrpl";
import { assertSignablePayment } from "../wallet-provider";
import type { WalletProvider, EnsureWalletOptions } from "../types";

/**
 * [MOCK] Deterministic wallets for tests: entropy = sha256(salt | walletRef)[0..16], so the
 * same salt always yields the same real xrpl.js key pair and the genuine signing path runs.
 * It never funds anything; fund through MockLedger.fund().
 */
export class MockWalletProvider implements WalletProvider {
  readonly ledger = "mock" as const;
  private readonly wallets = new Map<string, Wallet>();

  constructor(private readonly salt: string) {
    console.warn("[MOCK] MockWalletProvider: deterministic test wallets, never for production");
  }

  private wallet(walletRef: string): Wallet {
    let w = this.wallets.get(walletRef);
    if (!w) {
      const entropy = createHash("sha256")
        .update(`${this.salt}|${walletRef}`)
        .digest()
        .subarray(0, 16);
      w = Wallet.fromEntropy(entropy);
      this.wallets.set(walletRef, w);
    }
    return w;
  }

  async ensureWallet(
    walletRef: string,
    _options?: EnsureWalletOptions,
  ): Promise<{ address: string; created: boolean }> {
    const created = !this.wallets.has(walletRef);
    return { address: this.wallet(walletRef).classicAddress, created };
  }

  async getAddress(walletRef: string): Promise<string> {
    return this.wallet(walletRef).classicAddress;
  }

  async sign(
    walletRef: string,
    unsignedTx: Record<string, unknown>,
  ): Promise<{ txBlob: string; hash: string }> {
    const w = this.wallet(walletRef);
    assertSignablePayment(unsignedTx, w.classicAddress);
    const signed = w.sign(unsignedTx as Parameters<Wallet["sign"]>[0]);
    return { txBlob: signed.tx_blob, hash: signed.hash };
  }
}
