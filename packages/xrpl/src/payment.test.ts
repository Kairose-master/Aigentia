import { describe, expect, it } from "vitest";
import { XRP, hexToUtf8, sha256Hex, utf8ToHex, xrp } from "@aigentia/shared";
import { MEMO_TYPE_INVOICE, MEMO_TYPE_TEXT, buildPaymentTx } from "./payment";
import { RLUSD_CURRENCY_HEX } from "./asset";

const A = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const B = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

describe("buildPaymentTx", () => {
  it("encodes memo and InvoiceID for an invoice id", () => {
    const tx = buildPaymentTx({
      account: A,
      destination: B,
      amount: xrp(1000),
      invoiceId: "inv_42",
    });
    expect(tx.TransactionType).toBe("Payment");
    expect(tx.Amount).toBe("1000");
    expect(tx.InvoiceID).toBe(sha256Hex("inv_42").toUpperCase());
    expect(tx.InvoiceID).toMatch(/^[0-9A-F]{64}$/);
    expect(tx.Memos).toHaveLength(1);
    const memo = tx.Memos?.[0]?.Memo;
    expect(memo?.MemoType).toBe(MEMO_TYPE_INVOICE);
    expect(memo?.MemoData).toBe(utf8ToHex("inv_42"));
    expect(hexToUtf8(memo?.MemoData ?? "")).toBe("inv_42");
    expect(memo?.MemoData).toMatch(/^[0-9A-F]+$/);
  });

  it("adds a text memo, tags and issued amounts", () => {
    const tx = buildPaymentTx({
      account: A,
      destination: B,
      amount: {
        asset: { code: "RLUSD", issuer: B, currencyHex: RLUSD_CURRENCY_HEX },
        value: "1.5",
      },
      memoText: "hello",
      sourceTag: 804681468,
      destinationTag: 7,
    });
    expect(tx.Amount).toEqual({ currency: RLUSD_CURRENCY_HEX, issuer: B, value: "1.5" });
    expect(tx.InvoiceID).toBeUndefined();
    expect(tx.Memos?.[0]?.Memo.MemoType).toBe(MEMO_TYPE_TEXT);
    expect(tx.Memos?.[0]?.Memo.MemoData).toBe(utf8ToHex("hello"));
    expect(tx.SourceTag).toBe(804681468);
    expect(tx.DestinationTag).toBe(7);
  });

  it("omits Memos when nothing to say and refuses self payments", () => {
    const tx = buildPaymentTx({ account: A, destination: B, amount: { asset: XRP, value: "5" } });
    expect(tx.Memos).toBeUndefined();
    expect(() => buildPaymentTx({ account: A, destination: A, amount: xrp(1) })).toThrow(
      /destination/,
    );
  });
});
