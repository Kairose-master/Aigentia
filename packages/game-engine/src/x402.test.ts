import { describe, expect, it } from "vitest";
import { ScriptedBrain } from "@aigentia/agent-core/testing";
import {
  X402Client,
  decodePaymentSignature,
  encodePaymentSignature,
  type FetchFn,
} from "@aigentia/x402";
import { MockFacilitator } from "@aigentia/x402/testing";
import { buildTestWorld, type TestWorld } from "./testing";
import type { AgentRecord, ServiceRecord } from "./store/types";

const WAIT = { action: { type: "WAIT" }, summary: "Holding position.", reason: "Nothing to do." };

function buyScout(serviceId: string, maxPriceDrops = "5000") {
  return {
    action: { type: "BUY_SERVICE", serviceId, input: {}, maxPriceDrops },
    summary: "Buying SCOUT service from ATLAS-3.",
    reason: "Highest expected utility within my remaining budget.",
  };
}

async function scoutOf(world: TestWorld, seller: string): Promise<ServiceRecord> {
  const services = await world.store.listServices({ kind: "SCOUT" });
  const svc = services.find((s) => s.sellerAgentId === world.agent(seller).id);
  if (!svc) throw new Error("seller has no SCOUT service");
  return svc;
}

/** Two agents; the buyer's first decisions are scripted per test. */
async function duo(opts: {
  buyerDecisions: (scoutId: string) => unknown[];
  budgetPolicy?: Record<string, unknown>;
  facilitator?: (w: TestWorld) => MockFacilitator;
  failSettle?: boolean;
}): Promise<TestWorld> {
  let scoutId = "";
  let scripted: ScriptedBrain | null = null;
  const world = await buildTestWorld({
    seed: "x402-duo",
    x402: true,
    agents: [
      {
        name: "ORION-7",
        objective: "maximize_information",
        capitalXrp: 10,
        ...(opts.budgetPolicy ? { budgetPolicy: opts.budgetPolicy } : {}),
      },
      {
        name: "ATLAS-3",
        objective: "profitable_service",
        capitalXrp: 10,
        services: [{ kind: "SCOUT", priceDrops: "1000" }],
      },
    ],
    brainFor: (agent: AgentRecord) => {
      if (agent.name === "ORION-7") {
        scripted ??= new ScriptedBrain(opts.buyerDecisions(scoutId));
        return scripted;
      }
      return new ScriptedBrain([WAIT, WAIT, WAIT]);
    },
  });
  scoutId = (await scoutOf(world, "ATLAS-3")).id;
  return world;
}

describe("x402 agent-to-agent purchase on the [MOCK] ledger", () => {
  it("autonomous deterministic agents buy SCOUT intel over HTTP 402 and settle on the ledger", async () => {
    const world = await buildTestWorld({
      seed: "x402-acceptance",
      x402: true,
      agents: [
        { name: "VEGA-5", objective: "maximize_information", capitalXrp: 10 },
        {
          name: "ATLAS-3",
          objective: "profitable_service",
          capitalXrp: 10,
          services: [{ kind: "SCOUT", priceDrops: "1000" }],
        },
      ],
    });
    const seller = world.agent("ATLAS-3");
    const before = (await world.ledger.getBalanceDrops(seller.walletAddress)).balanceDrops;
    const ticks = await world.runTicks(3);
    const events = ticks.flatMap((t) => t.events);
    const fulfilled = events.find((e) => e.type === "SERVICE_FULFILLED");
    expect(fulfilled?.message).toMatch(/over x402/);
    const quoted = events.findIndex((e) => e.type === "SERVICE_QUOTED");
    const paid = events.findIndex(
      (e) => e.type === "PAYMENT_VALIDATED" && e.agentId === world.agent("VEGA-5").id,
    );
    expect(quoted).toBeGreaterThanOrEqual(0);
    expect(paid).toBeGreaterThan(quoted);

    const svc = await scoutOf(world, "ATLAS-3");
    expect(svc.successfulCalls).toBeGreaterThanOrEqual(1);
    const payments = await world.store.listPaymentsForAgent(world.agent("VEGA-5").id);
    const x402 = payments.filter((p) => p.kind === "x402" && p.status === "validated");
    expect(x402.length).toBe(svc.successfulCalls);
    for (const p of x402) {
      const inv = await world.store.getInvocationByInvoice(p.invoiceId ?? "");
      expect(inv?.status).toBe("fulfilled");
      expect(inv?.txHash).toBe(p.txHash);
      expect(inv?.buyerAgentId).toBe(world.agent("VEGA-5").id);
      await expect(
        world.ledger.verify(p.txHash ?? "", {
          destination: seller.walletAddress,
          amountDrops: 1000n,
          asset: { code: "XRP" },
          invoiceId: p.invoiceId ?? "",
        }),
      ).resolves.toMatchObject({ txHash: p.txHash });
    }
    const after = (await world.ledger.getBalanceDrops(seller.walletAddress)).balanceDrops;
    expect(after - before).toBe(1000n * BigInt(svc.successfulCalls));
    const buyer = await world.store.getAgent(world.agent("VEGA-5").id);
    expect((buyer?.strategy as { knowledge?: unknown[] }).knowledge?.length ?? 0).toBeGreaterThan(
      0,
    );
  });

  it("the PolicyEngine denies an over-budget purchase: nothing is signed, settled or executed", async () => {
    const world = await duo({
      buyerDecisions: (id) => [buyScout(id, "1000")],
      budgetPolicy: { maxSpendPerActionDrops: "500" },
    });
    const [tick] = await world.runTicks(1);
    expect(tick?.events.some((e) => e.type === "PAYMENT_DENIED")).toBe(true);
    expect(tick?.events.some((e) => e.type === "SERVICE_FULFILLED")).toBe(false);
    const svc = await scoutOf(world, "ATLAS-3");
    expect(svc.successfulCalls).toBe(0);
    const quote = tick?.events.find((e) => e.type === "SERVICE_QUOTED");
    const inv = await world.store.getInvocation(String(quote?.payload["invocationId"]));
    expect(inv?.status).toBe("quoted");
    expect(inv?.txHash).toBeNull();
  });

  it("a failed settlement grants no service and no output", async () => {
    let facilitator: MockFacilitator | null = null;
    const world = await buildTestWorld({
      seed: "x402-fail",
      x402: true,
      facilitator: {
        kind: "mock",
        supported: () => facilitator!.supported(),
        verify: (p, r) => facilitator!.verify(p, r),
        payerBuild: (r) => facilitator!.payerBuild(r),
        settle: async () => ({
          success: false,
          transaction: "",
          network: "xrpl:1",
          errorReason: "tecUNFUNDED_PAYMENT",
        }),
      },
      agents: [
        { name: "ORION-7", objective: "maximize_information", capitalXrp: 10 },
        {
          name: "ATLAS-3",
          objective: "profitable_service",
          capitalXrp: 10,
          services: [{ kind: "SCOUT", priceDrops: "1000" }],
        },
      ],
      brainFor: (agent) => (agent.name === "ORION-7" ? undefined : new ScriptedBrain([WAIT, WAIT])),
    });
    facilitator = new MockFacilitator(world.ledger);
    const [tick] = await world.runTicks(1);
    expect(tick?.events.some((e) => e.type === "PAYMENT_FAILED")).toBe(true);
    expect(tick?.events.some((e) => e.type === "SERVICE_FULFILLED")).toBe(false);
    expect((await scoutOf(world, "ATLAS-3")).successfulCalls).toBe(0);
    const payments = await world.store.listPaymentsForAgent(world.agent("ORION-7").id);
    expect(payments.find((p) => p.kind === "x402")?.status).toBe("failed");
  });

  describe("seller gate idempotency", () => {
    async function paidReceipt() {
      const world = await duo({ buyerDecisions: () => [WAIT] });
      const svc = await scoutOf(world, "ATLAS-3");
      const buyer = world.agent("ORION-7");
      const seller = world.agent("ATLAS-3");
      const gate = world.runtime.sellerGate;
      const fetchFn: FetchFn = async (url, init) => {
        const headers = new Headers(init?.headers);
        const r = await gate.handle({
          serviceId: svc.id,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
          paymentHeader: headers.get("payment-signature") ?? undefined,
          resourceUrl: url,
        });
        return Response.json(r.body, { status: r.status, headers: r.headers });
      };
      const client = new X402Client({
        fetch: fetchFn,
        facilitator: world.runtime.facilitator,
        walletProvider: world.runtime.walletProvider,
        verifier: world.ledger,
        network: "xrpl:1",
        networkId: 1,
      });
      const expectation = {
        network: "xrpl:1" as const,
        allowedAssets: ["XRP"],
        listedPriceDrops: 1000n,
        maxPriceDrops: 5000n,
        payTo: seller.walletAddress,
        sourceTag: world.env.X402_SOURCE_TAG,
        trustedFacilitators: [],
        maxTimeoutSeconds: world.env.X402_MAX_TIMEOUT_SECONDS,
      };
      const quote = async () =>
        client.handle402(await client.requestService(svc.endpoint, { input: {} }), expectation);
      const reqA = await quote();
      const receipt = await client.obtainReceipt(reqA, {
        walletRef: buyer.walletRef,
        account: buyer.walletAddress,
      });
      const first = await client.retryWithReceipt(svc.endpoint, { input: {} }, receipt);
      return { world, svc, client, receipt, first, quote, seller };
    }

    it("a duplicate x402 receipt is idempotent: same result, no second settlement or execution", async () => {
      const { world, svc, client, receipt, first, seller } = await paidReceipt();
      expect(first.status).toBe(200);
      const balance = (await world.ledger.getBalanceDrops(seller.walletAddress)).balanceDrops;
      const calls = (await world.store.getService(svc.id))?.successfulCalls;
      const again = await client.retryWithReceipt(svc.endpoint, { input: {} }, receipt);
      expect(again.status).toBe(200);
      expect((again.body as { replayed?: boolean }).replayed).toBe(true);
      expect((again.body as { output?: unknown }).output).toEqual(
        (first.body as { output?: unknown }).output,
      );
      expect(again.settlement?.transaction).toBe(receipt.txHash);
      expect((await world.store.getService(svc.id))?.successfulCalls).toBe(calls);
      expect((await world.ledger.getBalanceDrops(seller.walletAddress)).balanceDrops).toBe(balance);
    });

    it("one transaction hash cannot settle two unrelated purchases", async () => {
      const { world, svc, receipt, quote } = await paidReceipt();
      const reqB = await quote();
      // Re-point the already-settled signed blob at invoice B.
      const forged = encodePaymentSignature({
        ...decodePaymentSignature(receipt.paymentHeader),
        accepted: reqB,
        payload: {
          signedTxBlob: receipt.payload.payload.signedTxBlob,
          invoiceId: reqB.extra?.invoiceId ?? "",
        },
      });
      const res = await world.runtime.sellerGate.handle({
        serviceId: svc.id,
        body: { input: {} },
        paymentHeader: forged,
        resourceUrl: svc.endpoint,
      });
      expect(res.status).toBe(409);
      const invB = await world.store.getInvocationByInvoice(reqB.extra?.invoiceId ?? "");
      expect(invB?.status).toBe("quoted");
      expect(invB?.txHash).toBeNull();
    });
  });
});
