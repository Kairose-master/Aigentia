import { buildTestWorld } from "@aigentia/game-engine/testing";
import type { WorldEvent } from "@aigentia/protocol";
import { describe, expect, it } from "vitest";
import { InMemoryEventBus, decodeBusMessage, encodeBusMessage } from "@aigentia/game-engine";
import { ledgerTxRow } from "./indexer";
import { InMemoryLock, RELEASE_LOCK_SCRIPT } from "./lock";
import { agentsNeedingMockFunds, rehydrateMockBalances } from "./mock-balances";
import { agentReport, formatEventLine, formatPaymentLine } from "./scripts/report";

const event: WorldEvent = {
  id: 7,
  tick: 3,
  type: "PAYMENT_VALIDATED",
  message: "ORION-7 paid ATLAS-3 for intelligence",
  agentId: "agt_a",
  counterpartyId: "agt_b",
  experimentId: null,
  txHash: "ABCDEF0123456789",
  amountDrops: "1000",
  payload: {},
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("event bus wire format", () => {
  it("round-trips a WorldEvent as plain JSON", () => {
    const raw = encodeBusMessage(event);
    expect(JSON.parse(raw)).toMatchObject({ id: 7, tick: 3, type: event.type });
    expect(decodeBusMessage(raw)).toEqual(event);
  });

  it("rejects garbage and non-event messages", () => {
    expect(decodeBusMessage("not json")).toBeNull();
    expect(
      decodeBusMessage(JSON.stringify({ channel: "heartbeat", data: { at: "x" } })),
    ).toBeNull();
    expect(decodeBusMessage(JSON.stringify({ tick: -1 }))).toBeNull();
  });

  it("InMemoryEventBus delivers to subscribers until unsubscribed", async () => {
    const bus = new InMemoryEventBus();
    const seen: WorldEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    await bus.publish(event);
    off();
    await bus.publish(event);
    expect(seen).toHaveLength(1);
    expect(bus.published).toHaveLength(2);
  });
});

describe("InMemoryLock", () => {
  it("is exclusive, token-guarded and expires", async () => {
    let now = 1_000;
    const lock = new InMemoryLock(() => now);
    const a = await lock.acquire("k", 100);
    expect(a).not.toBeNull();
    expect(await lock.acquire("k", 100)).toBeNull();
    now += 101;
    const b = await lock.acquire("k", 100);
    expect(b).not.toBeNull();
    expect(await a?.release()).toBe(false);
    expect(lock.isHeld("k")).toBe(true);
    expect(await b?.release()).toBe(true);
    expect(lock.isHeld("k")).toBe(false);
  });

  it("release script compares the token before deleting", () => {
    expect(RELEASE_LOCK_SCRIPT).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
    expect(RELEASE_LOCK_SCRIPT).toContain('redis.call("del", KEYS[1])');
  });
});

describe("report formatting", () => {
  it("formats event lines with amount and truncated hash", () => {
    const line = formatEventLine(event);
    expect(line).toContain("[t3] PAYMENT_VALIDATED");
    expect(line).toContain("(0.001 XRP)");
    expect(line).toContain("tx=ABCDEF012345…");
  });

  it("formats payments with an explorer link on testnet and a [MOCK] note on mock", async () => {
    const world = await buildTestWorld({
      seed: "worker-report",
      agents: [{ name: "ORION-7", objective: "maximize_net_worth", capitalXrp: 10 }],
    });
    const orion = world.agent("ORION-7");
    const [funding] = await world.store.listPaymentsForAgent(orion.id);
    if (!funding) throw new Error("funding payment missing");
    expect(funding.status).toBe("validated");
    expect(funding.ledger).toBe("mock");
    const names = new Map([[orion.id, orion.name]]);
    const mockLine = formatPaymentLine(funding, { names, explorerBase: null });
    expect(mockLine).toContain("funding");
    expect(mockLine).toContain("→ ORION-7");
    expect(mockLine).toContain("10 XRP");
    expect(mockLine).toContain(`tx=${funding.txHash} [MOCK ledger, no explorer]`);
    const testnetLike = formatPaymentLine(
      { ...funding, ledger: "testnet" },
      { names, explorerBase: "https://testnet.xrpl.org/" },
    );
    expect(testnetLike).toContain(`https://testnet.xrpl.org/transactions/${funding.txHash}`);

    const report = agentReport({
      agent: orion,
      balance: await world.ledger.getBalanceDrops(orion.walletAddress),
      inventory: [],
      prices: await world.store.getMarketPrices(),
    });
    expect(report.balanceDrops).toBe(10_000_000n);
    expect(report.netWorthDrops).toBe(10_000_000n);
  });
});

describe("mock balance rehydration", () => {
  it("re-mints only agents whose mock account is empty", async () => {
    const world = await buildTestWorld({
      seed: "worker-rehydrate",
      agents: [{ name: "ORION-7", objective: "maximize_net_worth", capitalXrp: 10 }],
    });
    const orion = world.agent("ORION-7");
    const stale = {
      ...orion,
      id: "agt_stale",
      name: "STALE",
      walletAddress: "rrrrrrrrrrrrrrrrrrrrBZbvji",
    };
    expect(
      agentsNeedingMockFunds([orion, stale], (addr) =>
        addr === orion.walletAddress ? 10_000_000n : 0n,
      ).map((a) => a.name),
    ).toEqual(["STALE"]);
    const untouched = await rehydrateMockBalances(world.runtime, world.store);
    expect(untouched).toEqual({ ledger: "mock", funded: [], orphaned: [] });
    expect(
      await rehydrateMockBalances(
        { ledger: "testnet", mockLedger: null, walletProvider: world.runtime.walletProvider },
        world.store,
      ),
    ).toBeNull();
  });
});

describe("ledgerTxRow", () => {
  it("maps a LedgerTxRecord onto the ledger_transactions row", () => {
    const row = ledgerTxRow(
      {
        txHash: "HASH",
        ledgerIndex: 42,
        closeTime: new Date("2026-01-01T00:00:00Z"),
        transactionType: "Payment",
        sender: "rSender",
        receiver: "rReceiver",
        amountDrops: 1000n,
        feeDrops: 12n,
        result: "tesSUCCESS",
        validated: true,
        memo: "inv_1",
        invoiceIdHash: "ABC",
        raw: { x: 1 },
        ledger: "testnet",
      },
      "pay_1",
    );
    expect(row).toMatchObject({
      txHash: "HASH",
      ledger: "testnet",
      senderAddress: "rSender",
      receiverAddress: "rReceiver",
      amountDrops: 1000n,
      invoiceId: "ABC",
      paymentId: "pay_1",
      validated: true,
    });
  });
});
