import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { emptyResponseError, llmFailure, type LlmClient, type LlmRequest, type LlmResponse } from "./client";
import type { LlmConfig, LlmProvider } from "./config";

/** The slice of the OpenAI SDK this client uses; selftests pass a fake. */
export type OpenAiChatCompletionsApi = {
  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
};

export function openAiClientOptions(config: LlmConfig): ClientOptions {
  return {
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? null,
    maxRetries: 2,
    timeout: config.timeoutMs,
    // The SDK otherwise reads OPENAI_ORG_ID / OPENAI_PROJECT_ID from the
    // environment and would send them to third-party endpoints.
    ...(config.provider === "openai" ? {} : { organization: null, project: null }),
    ...(config.provider === "openrouter"
      ? { defaultHeaders: { "HTTP-Referer": "https://feature-rec.com", "X-Title": "Feature-Rec" } }
      : {}),
  };
}

/**
 * No temperature: reasoning models reject it. OpenAI's recent models reject
 * max_tokens in favor of max_completion_tokens, which most other
 * OpenAI-compatible servers do not know yet.
 */
export function buildOpenAiRequest(
  provider: LlmProvider,
  req: LlmRequest,
): ChatCompletionCreateParamsNonStreaming {
  const base = {
    model: req.model,
    messages: [
      { role: "system" as const, content: req.system },
      { role: "user" as const, content: req.user },
    ],
  };
  return provider === "openai"
    ? { ...base, max_completion_tokens: req.maxTokens }
    : { ...base, max_tokens: req.maxTokens };
}

/** Visible reasoning could contain a code fence that would be mistaken for the scene. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

export function normalizeOpenAiCompletion(
  completion: Pick<ChatCompletion, "choices" | "usage">,
  provider: LlmProvider,
  model: string,
): LlmResponse {
  const choice = completion.choices[0];
  const text = stripThinking(choice?.message.content ?? "").trim();
  const truncated = choice?.finish_reason === "length";
  if (!text && !truncated) throw emptyResponseError(provider, model);
  return {
    text,
    truncated,
    ...(completion.usage
      ? {
          usage: {
            inputTokens: completion.usage.prompt_tokens,
            outputTokens: completion.usage.completion_tokens,
          },
        }
      : {}),
    provider,
    model,
  };
}

export function createOpenAiCompatibleClient(
  config: LlmConfig,
  completions: OpenAiChatCompletionsApi = new OpenAI(openAiClientOptions(config)).chat.completions,
): LlmClient {
  return {
    async complete(req) {
      let completion: ChatCompletion;
      try {
        completion = await completions.create(buildOpenAiRequest(config.provider, req));
      } catch (err) {
        throw llmFailure(err, { provider: config.provider, model: req.model, apiKey: config.apiKey });
      }
      return normalizeOpenAiCompletion(completion, config.provider, req.model);
    },
  };
}
