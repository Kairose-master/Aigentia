import { describe, expect, it } from "vitest";
import { loadEnv, parseWalletSeeds } from "./env";

describe("env", () => {
  it("applies safe defaults", () => {
    const env = loadEnv({}, { reload: true });
    expect(env.TICK_SECONDS).toBe(60);
    expect(env.XRPL_NETWORK_ID).toBe(1);
    expect(env.SIM_LEDGER).toBe("testnet");
  });

  it("refuses Mainnet", () => {
    expect(() => loadEnv({ XRPL_NETWORK_ID: "0" }, { reload: true })).toThrow(/Mainnet/);
    expect(() => loadEnv({ XRPL_WSS_URL: "wss://xrplcluster.com" }, { reload: true })).toThrow(
      /Mainnet/,
    );
  });

  it("requires seeds when using the env wallet provider", () => {
    expect(() => loadEnv({ XRPL_WALLET_PROVIDER: "env" }, { reload: true })).toThrow(
      /XRPL_WALLET_SEEDS/,
    );
    expect(parseWalletSeeds('{"treasury":"sEdSeed"}')).toEqual({ treasury: "sEdSeed" });
    expect(parseWalletSeeds("")).toEqual({});
  });

  it("reports every invalid variable", () => {
    expect(() => loadEnv({ API_PORT: "abc", TICK_SECONDS: "0" }, { reload: true })).toThrow(
      /API_PORT[\s\S]*TICK_SECONDS/,
    );
  });
});
