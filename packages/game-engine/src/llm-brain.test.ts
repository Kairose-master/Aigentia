import { describe, expect, it } from "vitest";
import { LLMAgentBrain } from "@aigentia/agent-core";
import { mockModelSequence } from "@aigentia/agent-core/testing";
import { buildTestWorld } from "./testing";

/**
 * The LLM path end to end through the Simulation, with a scripted mock model (no paid API):
 * whatever the model says, it only ever produces a Decision that is Zod-validated, then
 * semantically validated, then policed by the PolicyEngine before any money moves.
 */
describe("LLMAgentBrain inside the simulation", () => {
  it("fails closed on hallucinated actions and lets the PolicyEngine stop overspending", async () => {
    let scoutId = "";
    const outputs = () => [
      // 1. Not an action in the vocabulary (tries to sign a transaction itself).
      {
        action: { type: "SIGN_TRANSACTION", blob: "DEADBEEF" },
        summary: "Signing.",
        reason: "Faster.",
      },
      // 2. Not JSON at all.
      "I think I should buy everything!",
      // 3. Valid shape, but far above the agent's per-action budget.
      {
        action: { type: "BUY_SERVICE", serviceId: scoutId, input: {}, maxPriceDrops: "9000000" },
        summary: "Buying SCOUT service from ATLAS-3.",
        reason: "Information is worth any price.",
      },
    ];
    let brain: LLMAgentBrain | null = null;
    const world = await buildTestWorld({
      seed: "llm-brain",
      agents: [
        { name: "ORION-7", objective: "maximize_information", capitalXrp: 10, brain: "llm" },
        {
          name: "ATLAS-3",
          objective: "profitable_service",
          capitalXrp: 10,
          services: [{ kind: "SCOUT", priceDrops: "2000000" }],
        },
      ],
      brainFor: (agent) => {
        if (agent.name !== "ORION-7") return undefined;
        brain ??= new LLMAgentBrain({
          model: mockModelSequence(outputs()),
          modelId: "mock/sequence",
          worldSeed: "llm-brain",
        });
        return brain;
      },
    });
    scoutId = (await world.store.listServices({ kind: "SCOUT" }))[0]?.id ?? "";
    brain = null; // rebuild with the real service id
    const orion = world.agent("ORION-7");
    const before = (await world.ledger.getBalanceDrops(orion.walletAddress)).balanceDrops;

    const ticks = await world.runTicks(3);
    const mine = ticks.map((t) => t.decisions.find((d) => d.agentId === orion.id));
    expect(mine[0]?.failedClosed).toBe(true);
    expect(mine[0]?.action.type).toBe("WAIT");
    expect(mine[1]?.failedClosed).toBe(true);
    expect(
      ticks[0]?.events.some((e) => e.type === "ACTION_INVALID" && e.agentId === orion.id),
    ).toBe(true);

    expect(mine[2]?.action.type).toBe("BUY_SERVICE");
    expect(
      ticks[2]?.events.some((e) => e.type === "PAYMENT_DENIED" && e.agentId === orion.id),
    ).toBe(true);
    expect(ticks[2]?.events.some((e) => e.type === "SERVICE_FULFILLED")).toBe(false);
    const after = (await world.ledger.getBalanceDrops(orion.walletAddress)).balanceDrops;
    expect(after).toBe(before);
  });
});
