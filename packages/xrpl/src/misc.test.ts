import { describe, expect, it } from "vitest";
import { XRP, loadEnv, xrp } from "@aigentia/shared";
import {
  RLUSD_CURRENCY_HEX,
  assetFromCode,
  moneyToXrplAmount,
  tryXrplAmountToMoney,
  xrplAmountToMoney,
} from "./asset";
import { explorerAccountUrl, explorerTxUrl } from "./explorer";
import { xrplConfigFromEnv } from "./types";

const issuer = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

describe("explorer urls", () => {
  it("builds transaction and account links", () => {
    expect(explorerTxUrl("https://testnet.xrpl.org", "ABC")).toBe(
      "https://testnet.xrpl.org/transactions/ABC",
    );
    expect(explorerTxUrl("https://testnet.xrpl.org/", "ABC")).toBe(
      "https://testnet.xrpl.org/transactions/ABC",
    );
    expect(explorerAccountUrl("https://testnet.xrpl.org", "rABC")).toBe(
      "https://testnet.xrpl.org/accounts/rABC",
    );
  });
});

describe("asset conversions", () => {
  it("round-trips XRP and RLUSD amounts", () => {
    expect(moneyToXrplAmount(xrp(1500))).toBe("1500");
    expect(xrplAmountToMoney("1500")).toEqual(xrp(1500));
    const rlusd = assetFromCode("RLUSD", issuer);
    expect(rlusd).toEqual({ code: "RLUSD", issuer, currencyHex: RLUSD_CURRENCY_HEX });
    const m = { asset: rlusd, value: "12.5" };
    expect(moneyToXrplAmount(m)).toEqual({ currency: RLUSD_CURRENCY_HEX, issuer, value: "12.5" });
    expect(xrplAmountToMoney({ currency: RLUSD_CURRENCY_HEX, issuer, value: "12.5" })).toEqual(m);
    expect(xrplAmountToMoney({ currency: "RLUSD", issuer, value: "1" })).toEqual({
      asset: rlusd,
      value: "1",
    });
    expect(assetFromCode("XRP")).toBe(XRP);
  });

  it("rejects unknown shapes", () => {
    expect(() => assetFromCode("RLUSD")).toThrow(/issuer/);
    expect(() => assetFromCode("DOGE")).toThrow(/unsupported/);
    expect(() => xrplAmountToMoney("1.5")).toThrow(/unsupported/);
    expect(() => xrplAmountToMoney({ mpt_issuance_id: "00", value: "1" })).toThrow(/unsupported/);
    expect(tryXrplAmountToMoney({ currency: "USD", issuer, value: "1" })).toBeNull();
    expect(tryXrplAmountToMoney(null)).toBeNull();
  });
});

describe("xrplConfigFromEnv", () => {
  it("derives caip2 and refuses mainnet or mismatched ids", () => {
    const env = loadEnv({}, { reload: true });
    const cfg = xrplConfigFromEnv(env);
    expect(cfg).toMatchObject({ name: "testnet", caip2: "xrpl:1", networkId: 1 });
    expect(cfg.wssUrl).toBe(env.XRPL_WSS_URL);
    expect(() => xrplConfigFromEnv({ ...env, XRPL_NETWORK_ID: 0 })).toThrow(/Mainnet/);
    expect(() => xrplConfigFromEnv({ ...env, XRPL_NETWORK: "devnet" })).toThrow(/expects/);
    expect(xrplConfigFromEnv({ ...env, XRPL_NETWORK: "devnet", XRPL_NETWORK_ID: 2 }).caip2).toBe(
      "xrpl:2",
    );
  });
});
