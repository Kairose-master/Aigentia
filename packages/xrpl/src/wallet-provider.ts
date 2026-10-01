import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AigentiaError,
  createLogger,
  errorMessage,
  isDropsString,
  parseWalletSeeds,
  sleep,
  type Env,
  type Logger,
} from "@aigentia/shared";
import { Wallet, isValidClassicAddress, type Transaction } from "xrpl";
import { rippledErrorCode } from "./client";
import { getString } from "./internal/tx-parse";
import type {
  EnsureWalletOptions,
  WalletProvider,
  XrplNetworkConfig,
  XrplRequestClient,
} from "./types";

/** Signer policy: never sign a transaction whose fee could exceed this. */
export const MAX_SIGNABLE_FEE_DROPS = 100_000n;

/**
 * Signer policy applied by every WalletProvider before signing. The unsigned tx must be a
 * Payment from the wallet's own address, to a valid destination, with a bounded fee.
 */
export function assertSignablePayment(
  unsignedTx: Record<string, unknown>,
  expectedAccount: string,
): void {
  const fail = (reason: string): never => {
    throw new AigentiaError("VALIDATION_FAILED", `refusing to sign: ${reason}`, {
      transactionType: unsignedTx["TransactionType"],
      account: unsignedTx["Account"],
    });
  };
  if (unsignedTx["TransactionType"] !== "Payment") fail("only Payment transactions are signed");
  if (unsignedTx["Account"] !== expectedAccount) fail("Account does not belong to this wallet");
  const destination = unsignedTx["Destination"];
  if (typeof destination !== "string" || !isValidClassicAddress(destination))
    fail("Destination missing or invalid");
  if (destination === expectedAccount) fail("Destination equals Account");
  const fee = unsignedTx["Fee"];
  if (!isDropsString(fee) || BigInt(fee) > MAX_SIGNABLE_FEE_DROPS)
    fail(`Fee must be a drops string <= ${MAX_SIGNABLE_FEE_DROPS}`);
  if (unsignedTx["Amount"] === undefined) fail("Amount missing");
  if (unsignedTx["TxnSignature"] !== undefined || unsignedTx["SigningPubKey"])
    fail("transaction is already signed");
}

function signWithWallet(
  wallet: Wallet,
  unsignedTx: Record<string, unknown>,
): { txBlob: string; hash: string } {
  assertSignablePayment(unsignedTx, wallet.classicAddress);
  const signed = wallet.sign(unsignedTx as unknown as Transaction);
  return { txBlob: signed.tx_blob, hash: signed.hash };
}

/** Wallets whose seeds are injected via XRPL_WALLET_SEEDS. Cannot create wallets. */
export class EnvWalletProvider implements WalletProvider {
  private readonly wallets = new Map<string, Wallet>();

  constructor(seeds: Record<string, string>) {
    for (const [ref, seed] of Object.entries(seeds)) {
      try {
        this.wallets.set(ref, Wallet.fromSeed(seed));
      } catch {
        throw new AigentiaError("VALIDATION_FAILED", `invalid seed for wallet "${ref}"`, {
          walletRef: ref,
        });
      }
    }
  }

  private wallet(walletRef: string): Wallet {
    const w = this.wallets.get(walletRef);
    if (!w) {
      throw new AigentiaError("NOT_FOUND", `no seed configured for wallet "${walletRef}"`, {
        walletRef,
      });
    }
    return w;
  }

  async ensureWallet(
    walletRef: string,
    _options?: EnsureWalletOptions,
  ): Promise<{ address: string; created: boolean }> {
    return { address: this.wallet(walletRef).classicAddress, created: false };
  }

  async getAddress(walletRef: string): Promise<string> {
    return this.wallet(walletRef).classicAddress;
  }

  async sign(
    walletRef: string,
    unsignedTx: Record<string, unknown>,
  ): Promise<{ txBlob: string; hash: string }> {
    return signWithWallet(this.wallet(walletRef), unsignedTx);
  }
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** POST { destination } to a Testnet faucet. Resolves once the faucet accepted the request. */
export async function requestFaucetFunding(
  faucetUrl: string,
  address: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(faucetUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ destination: address }),
    });
  } catch (e) {
    throw new AigentiaError("LEDGER_UNAVAILABLE", `faucet request failed: ${errorMessage(e)}`, {
      faucetUrl,
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AigentiaError("LEDGER_UNAVAILABLE", `faucet returned HTTP ${response.status}`, {
      faucetUrl,
      status: response.status,
      body: body.slice(0, 200),
    });
  }
}

/** Validated XRP balance of an account in drops; 0n when the account does not exist yet. */
export async function readBalanceDrops(
  client: XrplRequestClient,
  address: string,
): Promise<bigint> {
  try {
    const response = await client.request<{ result?: { account_data?: { Balance?: string } } }>({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    });
    const balance = response?.result?.account_data?.Balance;
    return typeof balance === "string" && /^\d+$/.test(balance) ? BigInt(balance) : 0n;
  } catch (e) {
    if (rippledErrorCode(e) === "actNotFound") return 0n;
    throw e;
  }
}

/** Poll until the validated balance exceeds `previousDrops`, or fail with LEDGER_UNAVAILABLE. */
export async function waitForBalanceAbove(
  client: XrplRequestClient,
  address: string,
  previousDrops: bigint,
  { timeoutMs = 60_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const balance = await readBalanceDrops(client, address);
    if (balance > previousDrops) return balance;
    if (Date.now() >= deadline) {
      throw new AigentiaError(
        "LEDGER_UNAVAILABLE",
        `faucet funding for ${address} not visible after ${timeoutMs}ms`,
        { address },
      );
    }
    await sleep(intervalMs);
  }
}

/** Poll account_info (validated) until the account exists, or fail with LEDGER_UNAVAILABLE. */
export async function waitForAccount(
  client: XrplRequestClient,
  address: string,
  { timeoutMs = 60_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await client.request({
        command: "account_info",
        account: address,
        ledger_index: "validated",
      });
      return;
    } catch (e) {
      if (rippledErrorCode(e) !== "actNotFound") throw e;
    }
    if (Date.now() >= deadline) {
      throw new AigentiaError(
        "LEDGER_UNAVAILABLE",
        `account ${address} not funded after ${timeoutMs}ms`,
        {
          address,
        },
      );
    }
    await sleep(intervalMs);
  }
}

interface WalletFileEntry {
  seed: string;
  address: string;
}

export interface FileWalletProviderOptions {
  readonly filePath: string;
  readonly faucetUrl: string;
  /** Used to wait until a freshly funded account exists on the ledger. */
  readonly client?: XrplRequestClient;
  readonly fetchImpl?: FetchLike;
  readonly fundTimeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * [DEV ONLY] Generates wallets on demand, funds them through the faucet and stores seeds in a
 * git-ignored JSON file (mode 0600). Never use in production: seeds live on disk in clear text.
 */
export class FileWalletProvider implements WalletProvider {
  private readonly log: Logger;
  private readonly opts: FileWalletProviderOptions;
  private cache: Record<string, WalletFileEntry> | undefined;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(options: FileWalletProviderOptions) {
    this.opts = options;
    this.log = options.logger ?? createLogger("xrpl.file-wallet-provider");
    this.log.warn(
      { filePath: options.filePath },
      "[DEV ONLY] FileWalletProvider stores wallet seeds on disk; never use in production",
    );
  }

  private async load(): Promise<Record<string, WalletFileEntry>> {
    if (this.cache) return this.cache;
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(await readFile(this.opts.filePath, "utf8"));
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== "ENOENT") {
        throw new AigentiaError("INTERNAL", `cannot read wallet file: ${errorMessage(e)}`, {
          filePath: this.opts.filePath,
        });
      }
    }
    const entries: Record<string, WalletFileEntry> = {};
    if (parsed && typeof parsed === "object") {
      for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
        const rec = value as Record<string, unknown> | null;
        const seed = getString(rec, "seed");
        const address = getString(rec, "address");
        if (seed && address) entries[ref] = { seed, address };
      }
    }
    this.cache = entries;
    return entries;
  }

  private async save(entries: Record<string, WalletFileEntry>): Promise<void> {
    await mkdir(dirname(this.opts.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
    await rename(tmp, this.opts.filePath);
    this.cache = entries;
  }

  /** Serialise wallet creation so two callers never generate the same ref twice. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  async ensureWallet(
    walletRef: string,
    options: EnsureWalletOptions = {},
  ): Promise<{ address: string; created: boolean }> {
    return this.serial(async () => {
      // Another process (API vs worker) may have added wallets since we last read the file.
      this.cache = undefined;
      const entries = await this.load();
      const existing = entries[walletRef];
      if (existing) return { address: existing.address, created: false };

      const wallet = Wallet.generate();
      const seed = wallet.seed;
      if (!seed) throw new AigentiaError("INTERNAL", "generated wallet has no seed");
      await this.save({ ...entries, [walletRef]: { seed, address: wallet.classicAddress } });
      this.log.info({ walletRef, address: wallet.classicAddress }, "generated dev wallet");

      if (options.fund) {
        await requestFaucetFunding(this.opts.faucetUrl, wallet.classicAddress, this.opts.fetchImpl);
        if (this.opts.client) {
          await waitForAccount(this.opts.client, wallet.classicAddress, {
            timeoutMs: this.opts.fundTimeoutMs ?? 60_000,
          });
        }
        this.log.info({ walletRef, address: wallet.classicAddress }, "dev wallet funded");
      }
      return { address: wallet.classicAddress, created: true };
    });
  }

  /** [DEV ONLY] Ask the faucet to fund an existing wallet again (e.g. a low treasury). */
  async topUp(walletRef: string): Promise<void> {
    const address = (await this.wallet(walletRef)).classicAddress;
    const before = this.opts.client ? await readBalanceDrops(this.opts.client, address) : 0n;
    await requestFaucetFunding(this.opts.faucetUrl, address, this.opts.fetchImpl);
    if (this.opts.client) {
      const after = await waitForBalanceAbove(this.opts.client, address, before, {
        timeoutMs: this.opts.fundTimeoutMs ?? 60_000,
      });
      this.log.info(
        { walletRef, address, before: String(before), after: String(after) },
        "dev wallet topped up",
      );
    }
  }

  private async wallet(walletRef: string): Promise<Wallet> {
    let entry = (await this.load())[walletRef];
    if (!entry) {
      // The wallet may have been created by another process since the file was cached.
      this.cache = undefined;
      entry = (await this.load())[walletRef];
    }
    if (!entry) {
      throw new AigentiaError(
        "NOT_FOUND",
        `wallet "${walletRef}" does not exist; call ensureWallet`,
        {
          walletRef,
        },
      );
    }
    return Wallet.fromSeed(entry.seed);
  }

  async getAddress(walletRef: string): Promise<string> {
    return (await this.wallet(walletRef)).classicAddress;
  }

  async sign(
    walletRef: string,
    unsignedTx: Record<string, unknown>,
  ): Promise<{ txBlob: string; hash: string }> {
    return signWithWallet(await this.wallet(walletRef), unsignedTx);
  }
}

export interface CreateWalletProviderDeps {
  readonly client?: XrplRequestClient;
  readonly fetchImpl?: FetchLike;
  readonly logger?: Logger;
}

/** Pick the WalletProvider selected by XRPL_WALLET_PROVIDER. The file provider is refused in production. */
export function createWalletProvider(
  env: Env,
  config: XrplNetworkConfig,
  deps: CreateWalletProviderDeps = {},
): WalletProvider {
  if (env.XRPL_WALLET_PROVIDER === "env") {
    return new EnvWalletProvider(parseWalletSeeds(env.XRPL_WALLET_SEEDS));
  }
  if (env.NODE_ENV === "production") {
    // A hosted Testnet demo may knowingly keep faucet-funded seeds on its own volume; that has
    // to be an explicit, named decision. Mainnet is refused earlier by loadEnv/xrplConfigFromEnv.
    if (env.XRPL_FILE_WALLET_ACK !== "testnet-only" || config.networkId === 0) {
      throw new AigentiaError(
        "VALIDATION_FAILED",
        "XRPL_WALLET_PROVIDER=file is DEV ONLY; use XRPL_WALLET_PROVIDER=env in production, " +
          "or set XRPL_FILE_WALLET_ACK=testnet-only to accept Testnet seeds on disk",
      );
    }
    (deps.logger ?? createLogger("xrpl.wallet-provider")).warn(
      { filePath: env.XRPL_WALLET_FILE, network: config.name },
      "XRPL_FILE_WALLET_ACK=testnet-only: Testnet wallet seeds are stored on this server's disk",
    );
  }
  return new FileWalletProvider({
    filePath: env.XRPL_WALLET_FILE,
    faucetUrl: config.faucetUrl,
    ...(deps.client ? { client: deps.client } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
