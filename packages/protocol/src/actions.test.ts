import { describe, expect, it } from "vitest";
import { agentActionSchema, decisionSchema } from "./actions";
import { x402PaymentRequiredSchema } from "./x402";

describe("agentActionSchema", () => {
  it("accepts every MVP action", () => {
    const ok = [
      { type: "WAIT" },
      {
        type: "BUY_SERVICE",
        serviceId: "svc_abcdef123456",
        input: { resourceType: "ore" },
        maxPriceDrops: "1000",
      },
      { type: "SELL_SERVICE", kind: "SCOUT", priceDrops: "1000" },
      {
        type: "POST_JOB",
        title: "Deliver ore",
        description: "10 ore to Core Station",
        rewardDrops: "50000",
      },
      { type: "ACCEPT_JOB", jobId: "job_abcdef123456" },
      { type: "SUBMIT_JOB", jobId: "job_abcdef123456", submission: { note: "done" } },
      { type: "TRANSFER", toAgentId: "agt_abcdef123456", amountDrops: "1000" },
      { type: "BUY_RESOURCE", resourceType: "ore", quantity: 3, maxUnitPriceDrops: "2000" },
      { type: "SELL_RESOURCE", resourceType: "ore", quantity: 3, unitPriceDrops: "2500" },
    ];
    for (const a of ok)
      expect(agentActionSchema.safeParse(a).success, JSON.stringify(a)).toBe(true);
  });

  it("fails closed on unknown, malformed or extra-typed actions", () => {
    const bad = [
      { type: "SIGN_TRANSACTION", blob: "DEADBEEF" },
      { type: "TRANSFER", toAgentId: "agt_abcdef123456", amountDrops: "-5" },
      { type: "TRANSFER", toAgentId: "agt_abcdef123456", amountDrops: 5 },
      { type: "BUY_SERVICE", serviceId: "svc_abcdef123456", maxPriceDrops: "0" },
      { type: "BUY_RESOURCE", resourceType: "gold", quantity: 1, maxUnitPriceDrops: "1" },
      "WAIT",
      null,
    ];
    for (const a of bad)
      expect(agentActionSchema.safeParse(a).success, JSON.stringify(a)).toBe(false);
  });

  it("requires a summary and reason on decisions", () => {
    expect(decisionSchema.safeParse({ action: { type: "WAIT" } }).success).toBe(false);
    expect(
      decisionSchema.safeParse({
        action: { type: "WAIT" },
        summary: "Holding.",
        reason: "Nothing worth buying.",
      }).success,
    ).toBe(true);
  });
});

describe("x402 wire schemas", () => {
  it("parses a valid 402 body and rejects malformed ones", () => {
    const body = {
      x402Version: 2,
      resource: { url: "http://localhost:4000/services/svc_x/invoke", description: "SCOUT" },
      accepts: [
        {
          scheme: "exact",
          network: "xrpl:1",
          amount: "1000",
          asset: "XRP",
          payTo: "rhaDe3NBxgUSLL12N5Sxpii2xy8vSyXNG6",
          maxTimeoutSeconds: 120,
          extra: { invoiceId: "inv-1", sourceTag: 804681468 },
        },
      ],
      extensions: {},
    };
    expect(x402PaymentRequiredSchema.safeParse(body).success).toBe(true);
    expect(x402PaymentRequiredSchema.safeParse({ ...body, x402Version: 1 }).success).toBe(false);
    expect(x402PaymentRequiredSchema.safeParse({ ...body, accepts: [] }).success).toBe(false);
    expect(
      x402PaymentRequiredSchema.safeParse({
        ...body,
        accepts: [{ ...body.accepts[0], network: "eip155:1" }],
      }).success,
    ).toBe(false);
    expect(
      x402PaymentRequiredSchema.safeParse({
        ...body,
        accepts: [{ ...body.accepts[0], payTo: "0xdeadbeef" }],
      }).success,
    ).toBe(false);
  });
});
