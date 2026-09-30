import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "@aigentia/shared";
import {
  EnvWalletProvider,
  FileWalletProvider,
  createWalletProvider,
  type FetchLike,
} from "./wallet-provider";
import { xrplConfigFromEnv } from "./types";
import type { XrplRequestClient } from "./types";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aigentia-wallets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileWalletProvider [DEV ONLY]", () => {
  it("generates, funds through the faucet, persists with mode 0600 and signs", async () => {
    const faucetCalls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      faucetCalls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      return { ok: true, status: 200, text: async () => "{}" };
    };
    let polls = 0;
    const client: XrplRequestClient = {
      async request<T>(): Promise<T> {
        polls += 1;
        if (polls < 2)
          throw Object.assign(new Error("actNotFound"), { data: { error: "actNotFound" } });
        return { result: { account_data: { Balance: "100" } } } as T;
      },
    };
    const filePath = join(dir, "nested", "wallets.dev.json");
    const provider = new FileWalletProvider({
      filePath,
      faucetUrl: "https://faucet.test/accounts",
      client,
      fetchImpl,
    });

    const first = await provider.ensureWallet("treasury");
    expect(first.created).toBe(true);
    expect(faucetCalls).toEqual([
      `POST https://faucet.test/accounts ${JSON.stringify({ destination: first.address })}`,
    ]);
    expect(polls).toBe(2);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      { seed: string; address: string }
    >;
    expect(stored["treasury"]?.address).toBe(first.address);
    expect(stored["treasury"]?.seed).toMatch(/^s/);

    const again = await provider.ensureWallet("treasury");
    expect(again).toEqual({ address: first.address, created: false });
    expect(faucetCalls).toHaveLength(1);

    const reloaded = new FileWalletProvider({
      filePath,
      faucetUrl: "https://faucet.test/accounts",
      fetchImpl,
    });
    expect(await reloaded.getAddress("treasury")).toBe(first.address);
    const signed = await reloaded.sign("treasury", {
      TransactionType: "Payment",
      Account: first.address,
      Destination: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
      Amount: "1",
      Fee: "12",
      Sequence: 1,
    });
    expect(signed.hash).toMatch(/^[0-9A-F]{64}$/);
    await expect(reloaded.getAddress("ghost")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("surfaces faucet failures as LEDGER_UNAVAILABLE", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 503, text: async () => "busy" });
    const provider = new FileWalletProvider({
      filePath: join(dir, "w.json"),
      faucetUrl: "https://faucet.test",
      fetchImpl,
    });
    await expect(provider.ensureWallet("x")).rejects.toMatchObject({ code: "LEDGER_UNAVAILABLE" });
  });
});

describe("createWalletProvider", () => {
  it("selects the provider from the environment and refuses file wallets in production", () => {
    const base = loadEnv({}, { reload: true });
    const cfg = xrplConfigFromEnv(base);
    expect(
      createWalletProvider({ ...base, XRPL_WALLET_FILE: join(dir, "w.json") }, cfg),
    ).toBeInstanceOf(FileWalletProvider);
    expect(
      createWalletProvider(
        {
          ...base,
          XRPL_WALLET_PROVIDER: "env",
          XRPL_WALLET_SEEDS: '{"treasury":"sEdTM1uX8pu2do5XvTnutH6HsouMaM2"}',
        },
        cfg,
      ),
    ).toBeInstanceOf(EnvWalletProvider);
    expect(() => createWalletProvider({ ...base, NODE_ENV: "production" }, cfg)).toThrow(
      /DEV ONLY/,
    );
  });
});
