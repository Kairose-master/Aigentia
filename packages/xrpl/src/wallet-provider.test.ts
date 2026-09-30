import { describe, expect, it } from "vitest";
import { Wallet, decode, verifySignature } from "xrpl";
import { isAigentiaError } from "@aigentia/shared";
import { EnvWalletProvider, assertSignablePayment } from "./wallet-provider";

const wallet = Wallet.generate();
const other = Wallet.generate();
const provider = new EnvWalletProvider({ treasury: wallet.seed ?? "" });

const unsigned = (): Record<string, unknown> => ({
  TransactionType: "Payment",
  Account: wallet.classicAddress,
  Destination: other.classicAddress,
  Amount: "1000",
  Fee: "12",
  Sequence: 5,
  LastLedgerSequence: 100,
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return isAigentiaError(e) ? e.code : "other";
  }
}

describe("EnvWalletProvider", () => {
  it("resolves addresses and signs a well-formed payment with the real key", async () => {
    expect(await provider.getAddress("treasury")).toBe(wallet.classicAddress);
    expect(await provider.ensureWallet("treasury")).toEqual({
      address: wallet.classicAddress,
      created: false,
    });
    const { txBlob, hash } = await provider.sign("treasury", unsigned());
    expect(hash).toMatch(/^[0-9A-F]{64}$/);
    expect(verifySignature(txBlob)).toBe(true);
    expect(decode(txBlob)["Account"]).toBe(wallet.classicAddress);
  });

  it("refuses a foreign Account", async () => {
    expect(
      await codeOf(provider.sign("treasury", { ...unsigned(), Account: other.classicAddress })),
    ).toBe("VALIDATION_FAILED");
  });

  it("refuses non-Payment transactions", async () => {
    expect(
      await codeOf(provider.sign("treasury", { ...unsigned(), TransactionType: "AccountSet" })),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(provider.sign("treasury", { ...unsigned(), TransactionType: "TrustSet" })),
    ).toBe("VALIDATION_FAILED");
  });

  it("refuses missing destination, excessive fees and unknown wallets", async () => {
    const noDest = unsigned();
    delete noDest["Destination"];
    expect(await codeOf(provider.sign("treasury", noDest))).toBe("VALIDATION_FAILED");
    expect(await codeOf(provider.sign("treasury", { ...unsigned(), Fee: "100001" }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await codeOf(provider.sign("treasury", { ...unsigned(), Fee: 12 }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await codeOf(provider.sign("ghost", unsigned()))).toBe("NOT_FOUND");
    expect(() =>
      assertSignablePayment({ ...unsigned(), Fee: "100000" }, wallet.classicAddress),
    ).not.toThrow();
  });

  it("rejects malformed seeds at construction", () => {
    expect(() => new EnvWalletProvider({ bad: "not-a-seed" })).toThrow(/invalid seed/);
  });
});
