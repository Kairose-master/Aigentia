import { MockLanguageModelV3 } from "ai/test";

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn("[MOCK] MockLanguageModelV3 in use: decisions are canned, no LLM is called.");
}

function emptyUsage(): {
  inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number };
  outputTokens: { total: number; text: number; reasoning: number };
} {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

/**
 * A Vercel AI SDK v3-spec mock model whose every generation returns `json`
 * (a string is returned verbatim, so malformed JSON can be simulated; anything else is
 * JSON.stringify-ed). Never calls the network.
 */
export function mockModelReturning(json: unknown, modelId = "mock-decision"): MockLanguageModelV3 {
  warnOnce();
  const text = typeof json === "string" ? json : JSON.stringify(json);
  return new MockLanguageModelV3({
    provider: "mock",
    modelId,
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
}

/** A mock model whose generation rejects with `error` (simulates provider outages). */
export function mockModelThrowing(error: unknown, modelId = "mock-failing"): MockLanguageModelV3 {
  warnOnce();
  return new MockLanguageModelV3({
    provider: "mock",
    modelId,
    doGenerate: async () => {
      throw error instanceof Error ? error : new Error(String(error));
    },
  });
}

/** A mock model that replays `texts` in order, then repeats the last one. */
export function mockModelSequence(
  texts: readonly unknown[],
  modelId = "mock-sequence",
): MockLanguageModelV3 {
  warnOnce();
  let i = 0;
  return new MockLanguageModelV3({
    provider: "mock",
    modelId,
    doGenerate: async () => {
      const value = texts[Math.min(i, texts.length - 1)];
      i += 1;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
}
