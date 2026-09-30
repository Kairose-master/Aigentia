/**
 * Opt-in XRPL Testnet integration test. Enable with XRPL_TESTNET_INTEGRATION=1.
 * Funds two throw-away wallets via the public faucet (seeds are kept in memory only),
 * sends 1000 drops with an invoice id, verifies it on the ledger and reads balances.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { xrp } from "@aigentia/shared";
import { LedgerBalanceReader } from "./balance-reader";
import { XRPLClient } from "./client";
import { explorerTxUrl } from "./explorer";
import { LedgerTransactionIndexer } from "./indexer";
import { sendPayment } from "./payment";
import { LedgerPaymentVerifier } from "./payment-verifier";
import type { XrplNetworkConfig } from "./types";
import { EnvWalletProvider, requestFaucetFunding, waitForAccount } from "./wallet-provider";

const enabled = process.env["XRPL_TESTNET_INTEGRATION"] === "1";

const config: XrplNetworkConfig = {
  name: "testnet",
  caip2: "xrpl:1",
  networkId: 1,
  wssUrl: process.env["XRPL_WSS_URL"] ?? "wss://testnet.xrpl-labs.com/",
  rpcUrl: process.env["XRPL_RPC_URL"] ?? "https://testnet.xrpl-labs.com/",
  explorerUrl: process.env["XRPL_EXPLORER_URL"] ?? "https://testnet.xrpl.org",
  faucetUrl: process.env["XRPL_FAUCET_URL"] ?? "https://faucet.altnet.rippletest.net/accounts",
};

describe.skipIf(!enabled)("XRPL Testnet integration (opt-in)", () => {
  const client = new XRPLClient(config);
  afterAll(async () => {
    await client.disconnect();
  });

  it("funds two wallets, pays 1000 drops with an invoice id, verifies and reads balances", async () => {
    await client.connect();
    await client.assertNetwork();

    const buyer = Wallet.generate();
    const seller = Wallet.generate();
    if (!buyer.seed || !seller.seed) throw new Error("generated wallets without seeds");
    const wallets = new EnvWalletProvider({ buyer: buyer.seed, seller: seller.seed });

    await requestFaucetFunding(config.faucetUrl, buyer.classicAddress);
    await requestFaucetFunding(config.faucetUrl, seller.classicAddress);
    await waitForAccount(client, buyer.classicAddress, { timeoutMs: 120_000 });
    await waitForAccount(client, seller.classicAddress, { timeoutMs: 120_000 });

    const reader = new LedgerBalanceReader(client);
    const sellerBefore = await reader.getBalanceDrops(seller.classicAddress);
    const buyerBefore = await reader.getBalanceDrops(buyer.classicAddress);
    expect(buyerBefore.spendableDrops).toBeGreaterThan(1000n);

    const invoiceId = `inv_it_${Date.now().toString(36)}`;
    const submitted = await sendPayment(client, wallets, "buyer", {
      destination: seller.classicAddress,
      amount: xrp(1000),
      invoiceId,
      sourceTag: 804681468,
    });
    console.log(`Testnet payment: ${explorerTxUrl(config.explorerUrl, submitted.hash)}`);
    expect(submitted.result).toBe("tesSUCCESS");
    expect(submitted.validated).toBe(true);
    expect(submitted.ledger).toBe("testnet");
    expect(submitted.deliveredDrops).toBe(1000n);

    const verified = await new LedgerPaymentVerifier(client).verify(submitted.hash, {
      destination: seller.classicAddress,
      amountDrops: 1000n,
      asset: { code: "XRP" },
      sender: buyer.classicAddress,
      invoiceId,
    });
    expect(verified.txHash).toBe(submitted.hash);
    expect(verified.ledgerIndex).toBe(submitted.ledgerIndex);
    expect(verified.invoiceId).toBe(invoiceId);
    expect(verified.sourceTag).toBe(804681468);
    expect(verified.ledger).toBe("testnet");
    expect(verified.closeTime.getTime()).toBeGreaterThan(Date.UTC(2020, 0, 1));

    const sellerAfter = await reader.getBalanceDrops(seller.classicAddress);
    const buyerAfter = await reader.getBalanceDrops(buyer.classicAddress);
    expect(sellerAfter.balanceDrops - sellerBefore.balanceDrops).toBe(1000n);
    expect(buyerBefore.balanceDrops - buyerAfter.balanceDrops).toBe(1000n + verified.feeDrops);
    expect(sellerAfter.reserveDrops).toBeGreaterThan(0n);

    const records = await new LedgerTransactionIndexer(client).indexAddress(seller.classicAddress, {
      sinceLedger: submitted.ledgerIndex,
    });
    const record = records.find((r) => r.txHash === submitted.hash);
    expect(record).toMatchObject({
      amountDrops: 1000n,
      memo: invoiceId,
      sender: buyer.classicAddress,
      ledger: "testnet",
    });
  }, 300_000);
});
