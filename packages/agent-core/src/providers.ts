import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { AigentiaError } from "@aigentia/shared";
import type { BrainKind } from "@aigentia/shared";
import type { AgentBrain } from "./brain";
import { DeterministicAgent } from "./deterministic-agent";
import { LLMAgentBrain } from "./llm-agent";
import { mockModelReturning } from "./testing/mock-model";

export type LLMProvider = "anthropic" | "openai" | "mock";

export interface CreateLanguageModelOptions {
  provider: LLMProvider;
  modelId: string;
  apiKey?: string;
}

export interface CreateBrainOptions {
  kind: BrainKind;
  worldSeed: string;
  /** Required for kind "llm". */
  provider?: LLMProvider;
  modelId?: string;
  apiKey?: string;
  temperature?: number;
  reflectWithModel?: boolean;
}

/** Canned decision used by the "mock" provider so a full stack can run without an LLM. */
export const MOCK_CANNED_DECISION = {
  action: { type: "WAIT" },
  summary: "Holding position.",
  reason: "Mock model: no live LLM configured.",
} as const;

export function createLanguageModel(options: CreateLanguageModelOptions): LanguageModel {
  const modelId = options.modelId.trim();
  if (!modelId) {
    throw new AigentiaError("VALIDATION_FAILED", "modelId is required to create a language model");
  }
  switch (options.provider) {
    case "anthropic": {
      if (!options.apiKey)
        throw new AigentiaError(
          "UNAUTHORIZED",
          "ANTHROPIC_API_KEY is required for provider anthropic",
        );
      return createAnthropic({ apiKey: options.apiKey })(modelId);
    }
    case "openai": {
      if (!options.apiKey)
        throw new AigentiaError("UNAUTHORIZED", "OPENAI_API_KEY is required for provider openai");
      return createOpenAI({ apiKey: options.apiKey })(modelId);
    }
    case "mock":
      return mockModelReturning(MOCK_CANNED_DECISION, modelId);
    default: {
      const exhaustive: never = options.provider;
      throw new AigentiaError("VALIDATION_FAILED", `unknown LLM provider ${String(exhaustive)}`);
    }
  }
}

export function createBrain(options: CreateBrainOptions): AgentBrain {
  if (options.kind === "deterministic")
    return new DeterministicAgent({ worldSeed: options.worldSeed });
  if (!options.provider || !options.modelId) {
    throw new AigentiaError(
      "VALIDATION_FAILED",
      "kind llm requires provider and modelId (LLM_PROVIDER / LLM_MODEL)",
    );
  }
  const model = createLanguageModel({
    provider: options.provider,
    modelId: options.modelId,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  });
  return new LLMAgentBrain({
    model,
    modelId: `${options.provider}/${options.modelId}`,
    worldSeed: options.worldSeed,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.reflectWithModel !== undefined
      ? { reflectWithModel: options.reflectWithModel }
      : {}),
  });
}
