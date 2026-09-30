import { describe, expect, it } from "vitest";
import { AigentiaError } from "@aigentia/shared";
import { LLMAgentBrain, buildSystemPrompt } from "./llm-agent";
import { createBrain, createLanguageModel } from "./providers";
import { ScriptedBrain } from "./testing/scripted-brain";
import { mockModelReturning, mockModelSequence, mockModelThrowing } from "./testing/mock-model";
import { syntheticObservation } from "./testing/fixtures";

const obs = syntheticObservation({ seed: "llm", objective: "maximize_information" });
const service = obs.availableServices[0]!;
const validDecision = {
  action: {
    type: "BUY_SERVICE",
    serviceId: service.id,
    input: { resourceType: "ore" },
    maxPriceDrops: service.priceDrops,
  },
  summary: `Buying SCOUT service from ${service.sellerName}.`,
  reason: "Highest expected utility within my remaining budget.",
  rationale: {
    goal: "maximize_information",
    expectedValueDrops: "12000",
    alternativesConsidered: ["WAIT"],
    confidence: 0.8,
  },
};

function brainWith(model: ReturnType<typeof mockModelReturning>): LLMAgentBrain {
  return new LLMAgentBrain({ model, modelId: "mock/test", worldSeed: "genesis", maxRetries: 0 });
}

describe("LLMAgentBrain", () => {
  it("parses and validates a valid decision from the model", async () => {
    const model = mockModelReturning(validDecision);
    const brain = brainWith(model);
    expect(brain.kind).toBe("llm");
    expect(brain.model).toBe("mock/test");
    const result = await brain.decide(obs);
    expect(result.failedClosed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.decision.action).toEqual(validDecision.action);
    expect(result.decision.summary).toBe(validDecision.summary);
    expect(result.decision.reason).toBe(validDecision.reason);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0]!;
    expect(call.responseFormat?.type).toBe("json");
    expect(call.prompt[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(call.prompt)).toContain(obs.agentId);
    expect(JSON.stringify(call.prompt)).not.toContain("genesis");
  });

  it("fails closed to WAIT on an unknown action type", async () => {
    const brain = brainWith(
      mockModelReturning({
        action: { type: "SIGN_TRANSACTION", blob: "DEADBEEF" },
        summary: "Signing.",
        reason: "No.",
      }),
    );
    const result = await brain.decide(obs);
    expect(result.failedClosed).toBe(true);
    expect(result.decision.action).toEqual({ type: "WAIT" });
    expect(result.decision.summary).toBe("Holding position.");
    expect(result.error).toBeDefined();
  });

  it("fails closed to WAIT on a bare action object", async () => {
    const result = await brainWith(mockModelReturning({ type: "SIGN_TRANSACTION" })).decide(obs);
    expect(result.failedClosed).toBe(true);
    expect(result.decision.action).toEqual({ type: "WAIT" });
  });

  it("fails closed to WAIT on malformed JSON", async () => {
    const result = await brainWith(mockModelReturning('{"action": {"type": "WAIT"')).decide(obs);
    expect(result.failedClosed).toBe(true);
    expect(result.decision.action).toEqual({ type: "WAIT" });
    expect(result.error).toMatch(/model call failed/);
  });

  it("fails closed to WAIT when the model throws", async () => {
    const result = await brainWith(mockModelThrowing(new Error("provider down"))).decide(obs);
    expect(result.failedClosed).toBe(true);
    expect(result.decision.action).toEqual({ type: "WAIT" });
    expect(result.error).toContain("provider down");
  });

  it("fails closed on amounts that are not drops strings", async () => {
    const bad = { ...validDecision, action: { ...validDecision.action, maxPriceDrops: 5000 } };
    const result = await brainWith(mockModelReturning(bad)).decide(obs);
    expect(result.failedClosed).toBe(true);
  });

  it("reflectOnOutcome is deterministic and makes no model call by default", async () => {
    const model = mockModelReturning(validDecision);
    const brain = brainWith(model);
    const { decision } = await brain.decide(obs);
    const before = model.doGenerateCalls.length;
    const memory = await brain.reflectOnOutcome(obs, decision, {
      status: "success",
      outcome: "ok",
      costDrops: 1000n,
    });
    expect(model.doGenerateCalls.length).toBe(before);
    expect(memory.ticksSinceLastPurchase).toBe(0);
    expect(memory.lessons).toEqual([]);
  });

  it("reflectOnOutcome may use the model when opted in, and tolerates failures", async () => {
    const model = mockModelSequence([
      validDecision,
      { lesson: "Cheap intel paid off." },
      "not json",
    ]);
    const brain = new LLMAgentBrain({
      model,
      modelId: "mock/reflect",
      worldSeed: "g",
      maxRetries: 0,
      reflectWithModel: true,
    });
    const { decision } = await brain.decide(obs);
    const m1 = await brain.reflectOnOutcome(obs, decision, { status: "success", outcome: "ok" });
    expect(m1.lessons).toEqual(["Cheap intel paid off."]);
    const m2 = await brain.reflectOnOutcome({ ...obs, memory: m1 }, decision, {
      status: "failed",
      outcome: "x",
    });
    expect(m2.lessons).toEqual(["Cheap intel paid off."]);
    expect(m2.consecutiveFailures).toBe(1);
  });

  it("system prompt explains the contract without leaking anything secret", () => {
    const prompt = buildSystemPrompt();
    for (const t of [
      "WAIT",
      "BUY_SERVICE",
      "SELL_SERVICE",
      "POST_JOB",
      "ACCEPT_JOB",
      "SUBMIT_JOB",
      "TRANSFER",
      "BUY_RESOURCE",
      "SELL_RESOURCE",
    ])
      expect(prompt).toContain(t);
    expect(prompt).toContain("drops");
    expect(prompt).toContain("maxSpendPerActionDrops");
    expect(prompt).toMatch(/single short sentence/);
    expect(prompt.toLowerCase()).not.toContain("seed");
  });
});

describe("ScriptedBrain", () => {
  it("replays valid decisions and fails closed on garbage through the same path", async () => {
    const brain = new ScriptedBrain([
      validDecision,
      JSON.stringify(validDecision),
      { type: "SIGN_TRANSACTION" },
      "{not json",
      null,
      new Error("boom"),
      { action: { type: "WAIT" }, summary: "Holding position.", reason: "Scripted." },
    ]);
    expect(brain.kind).toBe("llm");
    const r1 = await brain.decide(obs);
    expect(r1.failedClosed).toBe(false);
    expect(r1.decision.action).toEqual(validDecision.action);
    const r2 = await brain.decide(obs);
    expect(r2.failedClosed).toBe(false);
    for (let i = 0; i < 4; i++) {
      const r = await brain.decide(obs);
      expect(r.failedClosed).toBe(true);
      expect(r.decision.action).toEqual({ type: "WAIT" });
    }
    const last = await brain.decide(obs);
    expect(last.failedClosed).toBe(false);
    expect(last.decision.reason).toBe("Scripted.");
    const again = await brain.decide(obs);
    expect(again.decision.reason).toBe("Scripted.");
    expect(brain.calls).toHaveLength(8);
  });

  it("fails closed when the script is empty", async () => {
    const r = await new ScriptedBrain([]).decide(obs);
    expect(r.failedClosed).toBe(true);
    expect(r.decision.action).toEqual({ type: "WAIT" });
  });
});

describe("providers", () => {
  it("createBrain builds a DeterministicAgent", () => {
    const brain = createBrain({ kind: "deterministic", worldSeed: "g" });
    expect(brain.kind).toBe("deterministic");
  });

  it("createBrain with the mock provider returns a working LLM brain", async () => {
    const brain = createBrain({ kind: "llm", provider: "mock", modelId: "canned", worldSeed: "g" });
    expect(brain.kind).toBe("llm");
    expect(brain.model).toBe("mock/canned");
    const r = await brain.decide(obs);
    expect(r.failedClosed).toBe(false);
    expect(r.decision.action).toEqual({ type: "WAIT" });
  });

  it("createBrain kind llm without provider/model fails loudly", () => {
    expect(() => createBrain({ kind: "llm", worldSeed: "g" })).toThrow(AigentiaError);
  });

  it("createLanguageModel requires api keys and a model id", () => {
    expect(() => createLanguageModel({ provider: "anthropic", modelId: "claude-x" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() => createLanguageModel({ provider: "openai", modelId: "gpt-x" })).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() => createLanguageModel({ provider: "mock", modelId: "  " })).toThrow(/modelId/);
  });

  it("createLanguageModel wraps provider models into the v3 spec without touching the network", () => {
    const anthropic = createLanguageModel({
      provider: "anthropic",
      modelId: "claude-test",
      apiKey: "sk-test",
    });
    const openai = createLanguageModel({
      provider: "openai",
      modelId: "gpt-test",
      apiKey: "sk-test",
    });
    for (const model of [anthropic, openai]) {
      expect(typeof model).toBe("object");
      if (typeof model === "string") throw new Error("unexpected model id string");
      expect(model.specificationVersion).toBe("v3");
    }
    if (typeof anthropic !== "string") expect(anthropic.modelId).toBe("claude-test");
    if (typeof openai !== "string") expect(openai.modelId).toBe("gpt-test");
  });
});

describe("provider models", () => {
  it("builds spec-v3 models the installed ai SDK accepts, without any network call", async () => {
    const { createLanguageModel } = await import("./providers");
    for (const provider of ["anthropic", "openai"] as const) {
      const model = createLanguageModel({ provider, modelId: "test-model", apiKey: "test-key" });
      expect(typeof model === "object" && model.specificationVersion).toBe("v3");
    }
    expect(() => createLanguageModel({ provider: "anthropic", modelId: "x" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
