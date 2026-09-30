import { AigentiaError, XRPL_NETWORKS, type Asset, type Env, type Money } from "@aigentia/shared";

/** Which ledger produced a value. Only the clearly labelled MockLedger produces "mock". */
export type LedgerKind = "testnet" | "mock";

export interface XrplNetworkConfig {
  readonly name: "testnet" | "devnet";
  readonly caip2: "xrpl:1" | "xrpl:2";
  readonly networkId: number;
  readonly wssUrl: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly faucetUrl: string;
}

/**
 * Derive the XRPL network configuration from the validated environment.
 * Mainnet (network id 0) is refused outright; the network name and id must agree.
 */
export function xrplConfigFromEnv(env: Env): XrplNetworkConfig {
  if (env.XRPL_NETWORK_ID === 0) {
    throw new AigentiaError(
      "VALIDATION_FAILED",
      "Aigentia refuses to run against XRPL Mainnet (network id 0)",
      { networkId: env.XRPL_NETWORK_ID },
    );
  }
  const known = XRPL_NETWORKS[env.XRPL_NETWORK];
  if (known.networkId !== env.XRPL_NETWORK_ID) {
    throw new AigentiaError(
      "VALIDATION_FAILED",
      `XRPL_NETWORK=${env.XRPL_NETWORK} expects XRPL_NETWORK_ID=${known.networkId}, got ${env.XRPL_NETWORK_ID}`,
      { network: env.XRPL_NETWORK, networkId: env.XRPL_NETWORK_ID },
    );
  }
  return {
    name: env.XRPL_NETWORK,
    caip2: known.caip2,
    networkId: known.networkId,
    wssUrl: env.XRPL_WSS_URL,
    rpcUrl: env.XRPL_RPC_URL,
    explorerUrl: env.XRPL_EXPLORER_URL,
    faucetUrl: env.XRPL_FAUCET_URL,
  };
}

/** Anything that can answer rippled JSON-RPC style commands (XRPLClient or a test stub). */
export interface XrplRequestClient {
  request<T = unknown>(cmd: Record<string, unknown>): Promise<T>;
}

/** Anything that can autofill and submit a signed transaction (XRPLClient or MockLedger). */
export interface TransactionSubmitter {
  readonly ledger: LedgerKind;
  autofill(tx: Record<string, unknown>): Promise<Record<string, unknown>>;
  submitAndWait(txBlob: string): Promise<SubmitResult>;
}

export interface EnsureWalletOptions {
  /**
   * Fund a NEWLY created wallet through the Testnet faucet. Only development providers honour
   * it (the treasury bootstrap uses it); agents are activated by the treasury's funding payment.
   */
  readonly fund?: boolean;
}

export interface WalletProvider {
  ensureWallet(
    walletRef: string,
    options?: EnsureWalletOptions,
  ): Promise<{ address: string; created: boolean }>;
  getAddress(walletRef: string): Promise<string>;
  sign(
    walletRef: string,
    unsignedTx: Record<string, unknown>,
  ): Promise<{ txBlob: string; hash: string }>;
  /** Development providers only: top an existing wallet up from the faucet. */
  topUp?(walletRef: string): Promise<void>;
}

export interface BalanceSnapshot {
  readonly balanceDrops: bigint;
  readonly reserveDrops: bigint;
  /** balance − reserve, never negative. */
  readonly spendableDrops: bigint;
}

export interface BalanceReader {
  getBalanceDrops(address: string): Promise<BalanceSnapshot>;
}

export interface PaymentExpectation {
  readonly destination: string;
  /** Expected delivered amount in drops (XRP). For issued currencies use `amountValue`. */
  readonly amountDrops: bigint;
  readonly asset: Asset;
  /** Decimal value string for issued-currency expectations; ignored for XRP. */
  readonly amountValue?: string;
  readonly sender?: string;
  readonly invoiceId?: string;
}

export interface VerifiedPayment {
  readonly txHash: string;
  readonly ledgerIndex: number;
  readonly closeTime: Date;
  readonly sender: string;
  readonly destination: string;
  readonly amount: Money;
  readonly feeDrops: bigint;
  readonly invoiceId?: string;
  readonly sourceTag?: number;
  readonly destinationTag?: number;
  readonly ledger: LedgerKind;
}

export interface PaymentVerifier {
  /** Throws AigentiaError("PAYMENT_UNVERIFIED") on any mismatch. */
  verify(txHash: string, expect: PaymentExpectation): Promise<VerifiedPayment>;
}

export interface LedgerTxRecord {
  readonly txHash: string;
  readonly ledgerIndex: number;
  readonly closeTime: Date | null;
  readonly transactionType: string;
  readonly sender: string;
  readonly receiver: string | null;
  /** Delivered XRP in drops; null for non-XRP or non-payment transactions. */
  readonly amountDrops: bigint | null;
  readonly feeDrops: bigint | null;
  readonly result: string;
  readonly validated: boolean;
  /** Decoded UTF-8 of the first memo, if any. */
  readonly memo: string | null;
  /** The 256-bit InvoiceID field, if any. */
  readonly invoiceIdHash: string | null;
  readonly raw: Record<string, unknown>;
  readonly ledger: LedgerKind;
}

export interface IndexAddressOptions {
  readonly sinceLedger?: number;
  readonly limit?: number;
}

export interface TransactionIndexer {
  indexAddress(address: string, options?: IndexAddressOptions): Promise<LedgerTxRecord[]>;
}

export interface SubmitResult {
  readonly hash: string;
  readonly ledgerIndex: number;
  /** rippled TransactionResult, e.g. "tesSUCCESS" or "tecUNFUNDED_PAYMENT". */
  readonly result: string;
  readonly validated: boolean;
  readonly deliveredDrops?: bigint;
  readonly meta: Record<string, unknown> | null;
  readonly ledger: LedgerKind;
}

/** A validated transaction fetched from a ledger, in a shape both the real and mock ledgers can produce. */
export interface LedgerTransaction {
  readonly hash: string;
  readonly ledgerIndex: number | null;
  readonly validated: boolean;
  readonly closeTime: Date | null;
  readonly tx: Record<string, unknown>;
  readonly meta: Record<string, unknown> | null;
}
