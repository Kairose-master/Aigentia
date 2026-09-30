import { describe, expect, it } from "vitest";
import { generateText, tool } from "ai";
import { z } from "zod";
import { bridgeV4ToV3 } from "./provider-bridge";
import type { LanguageModelV4 } from "./provider-bridge";
import { LLMAgentBrain } from "./llm-agent";
import { syntheticObservation } from "./testing/fixtures";

type V4Options = Parameters<LanguageModelV4["doGenerate"]>[0];
type V4Result = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>;

/** Hand-rolled v4-spec model (what @ai-sdk/anthropic@4 / openai@4 return) that records calls. */
function fakeV4(text: string): { model: LanguageModelV4; calls: V4Options[] } {
  const calls: V4Options[] = [];
  const result: V4Result = {
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text },
    ],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [{ type: "deprecated", setting: "topK", message: "ignored" }],
    response: { id: "resp_1", modelId: "fake-v4", timestamp: new Date(0) },
  };
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-v4",
    supportedUrls: {},
    doGenerate: async (options) => {
      calls.push(options);
      return result;
    },
    doStream: async () => {
      throw new Error("not used");
    },
  };
  return { model, calls };
}

describe("bridgeV4ToV3", () => {
  it("lets ai@6 generateText drive a v4 provider model for text + JSON output", async () => {
    const { model, calls } = fakeV4('{"ok": true}');
    const bridged = bridgeV4ToV3(model);
    expect(bridged.specificationVersion).toBe("v3");
    expect(bridged.modelId).toBe("fake-v4");
    const result = await generateText({
      model: bridged,
      system: "sys",
      prompt: "hello",
      temperature: 0.1,
      maxRetries: 0,
    });
    expect(result.text).toBe('{"ok": true}');
    expect(result.finishReason).toBe("stop");
    expect(result.warnings).toEqual([{ type: "other", message: "topK: ignored" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(calls[0]?.temperature).toBe(0.1);
  });

  it("drives a full LLMAgentBrain decision through the bridge", async () => {
    const obs = syntheticObservation({ objective: "survive" });
    const { model, calls } = fakeV4(
      JSON.stringify({
        action: { type: "WAIT" },
        summary: "Holding position.",
        reason: "Bridged.",
      }),
    );
    const brain = new LLMAgentBrain({
      model: bridgeV4ToV3(model),
      modelId: "fake/v4",
      worldSeed: "g",
      maxRetries: 0,
    });
    const r = await brain.decide(obs);
    expect(r.failedClosed).toBe(false);
    expect(r.decision.reason).toBe("Bridged.");
    expect(calls[0]?.responseFormat?.type).toBe("json");
  });

  it("refuses tools and streaming instead of silently mis-mapping them", async () => {
    const { model } = fakeV4("x");
    const bridged = bridgeV4ToV3(model);
    await expect(
      generateText({
        model: bridged,
        prompt: "hi",
        maxRetries: 0,
        tools: { noop: tool({ description: "noop", inputSchema: z.object({}) }) },
      }),
    ).rejects.toThrow(/tools is not supported/);
    await expect(bridged.doStream({ prompt: [] })).rejects.toThrow(/streaming/);
  });
});
