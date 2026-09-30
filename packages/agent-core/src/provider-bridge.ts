import type { createAnthropic } from "@ai-sdk/anthropic";
import type { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { AigentiaError } from "@aigentia/shared";

/**
 * Version bridge between the installed provider packages and the installed core SDK.
 *
 * `ai@6` (`generateText`) accepts models with `specificationVersion: "v2" | "v3"` and
 * throws `UnsupportedModelVersionError` for anything else, while `@ai-sdk/anthropic@4`
 * and `@ai-sdk/openai@4` return `"v4"` models. The two specs coincide for the only
 * surface this package uses — a system + user text prompt, a JSON response format and
 * text content back — so this module maps exactly that surface, field by field, and
 * refuses everything else (files, tools, streaming) with a clear error. No casts.
 *
 * Delete this file once the dependency versions are aligned (see openIssues).
 */
export type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type V3CallOptions = Parameters<LanguageModelV3["doGenerate"]>[0];
type V3GenerateResult = Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
type V3Message = V3CallOptions["prompt"][number];
type V3Content = V3GenerateResult["content"][number];
type V3Warning = V3GenerateResult["warnings"][number];

type AnthropicModel = ReturnType<ReturnType<typeof createAnthropic>["languageModel"]>;
type OpenAIModel = ReturnType<ReturnType<typeof createOpenAI>["languageModel"]>;
/** A v4-spec model as produced by the installed provider packages. */
export type LanguageModelV4 = AnthropicModel | OpenAIModel;
type V4CallOptions = Parameters<AnthropicModel["doGenerate"]>[0];
type V4GenerateResult = Awaited<ReturnType<AnthropicModel["doGenerate"]>>;
type V4Message = V4CallOptions["prompt"][number];
type V4Warning = V4GenerateResult["warnings"][number];

function unsupported(feature: string): AigentiaError {
  return new AigentiaError("INTERNAL", `provider bridge: ${feature} is not supported`, {
    feature,
  });
}

function mapMessage(message: V3Message): V4Message {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content: message.content.map((part) => {
          if (part.type !== "text") throw unsupported(`user ${part.type} parts`);
          return { type: "text", text: part.text };
        }),
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content.map((part) => {
          if (part.type !== "text") throw unsupported(`assistant ${part.type} parts`);
          return { type: "text", text: part.text };
        }),
      };
    case "tool":
      throw unsupported("tool messages");
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

function mapOptions(options: V3CallOptions): V4CallOptions {
  if (options.tools !== undefined && options.tools.length > 0) throw unsupported("tools");
  if (options.toolChoice !== undefined && options.toolChoice.type !== "none")
    throw unsupported("toolChoice");
  const responseFormat: V4CallOptions["responseFormat"] =
    options.responseFormat === undefined
      ? undefined
      : options.responseFormat.type === "text"
        ? { type: "text" }
        : {
            type: "json",
            ...(options.responseFormat.schema !== undefined
              ? { schema: options.responseFormat.schema }
              : {}),
            ...(options.responseFormat.name !== undefined
              ? { name: options.responseFormat.name }
              : {}),
            ...(options.responseFormat.description !== undefined
              ? { description: options.responseFormat.description }
              : {}),
          };
  return {
    prompt: options.prompt.map(mapMessage),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stopSequences !== undefined ? { stopSequences: options.stopSequences } : {}),
    ...(options.topP !== undefined ? { topP: options.topP } : {}),
    ...(options.topK !== undefined ? { topK: options.topK } : {}),
    ...(options.presencePenalty !== undefined ? { presencePenalty: options.presencePenalty } : {}),
    ...(options.frequencyPenalty !== undefined
      ? { frequencyPenalty: options.frequencyPenalty }
      : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(responseFormat !== undefined ? { responseFormat } : {}),
    ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  };
}

function mapWarning(warning: V4Warning): V3Warning {
  switch (warning.type) {
    case "unsupported":
    case "compatibility":
      return {
        type: warning.type,
        feature: warning.feature,
        ...(warning.details !== undefined ? { details: warning.details } : {}),
      };
    case "deprecated":
      return { type: "other", message: `${warning.setting}: ${warning.message}` };
    case "other":
      return { type: "other", message: warning.message };
    default: {
      const exhaustive: never = warning;
      return exhaustive;
    }
  }
}

function mapResult(result: V4GenerateResult): V3GenerateResult {
  const content: V3Content[] = [];
  for (const part of result.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "reasoning") content.push({ type: "reasoning", text: part.text });
    // Files, sources, tool calls and custom parts cannot occur for a text-only JSON call;
    // if a provider emits them anyway they are dropped and the text is what gets parsed.
  }
  const response = result.response;
  return {
    content,
    finishReason: { unified: result.finishReason.unified, raw: result.finishReason.raw },
    usage: {
      inputTokens: {
        total: result.usage.inputTokens.total,
        noCache: result.usage.inputTokens.noCache,
        cacheRead: result.usage.inputTokens.cacheRead,
        cacheWrite: result.usage.inputTokens.cacheWrite,
      },
      outputTokens: {
        total: result.usage.outputTokens.total,
        text: result.usage.outputTokens.text,
        reasoning: result.usage.outputTokens.reasoning,
      },
    },
    warnings: result.warnings.map(mapWarning),
    ...(result.request !== undefined ? { request: { body: result.request.body } } : {}),
    ...(response !== undefined
      ? {
          response: {
            ...(response.id !== undefined ? { id: response.id } : {}),
            ...(response.timestamp !== undefined ? { timestamp: response.timestamp } : {}),
            ...(response.modelId !== undefined ? { modelId: response.modelId } : {}),
            ...(response.headers !== undefined ? { headers: response.headers } : {}),
            ...(response.body !== undefined ? { body: response.body } : {}),
          },
        }
      : {}),
  };
}

/** Wrap a v4-spec provider model so `ai@6` `generateText` accepts it (text + JSON only). */
export function bridgeV4ToV3(model: LanguageModelV4): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls;
    },
    async doGenerate(options) {
      const result = await model.doGenerate(mapOptions(options));
      return mapResult(result);
    },
    doStream() {
      return Promise.reject(unsupported("streaming"));
    },
  };
}
