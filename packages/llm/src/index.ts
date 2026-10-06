import { createAnthropicClient } from "./anthropic";
import type { LlmClient, LlmResponse } from "./client";
import type { LlmConfig } from "./config";
import { createOpenAiCompatibleClient } from "./openai";

export {
  API_KEY_VARIABLES,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TOKENS,
  LLM_API_KEY_VARIABLES,
  LLM_PROVIDERS,
  resolveLlmConfig,
  type LlmConfig,
  type LlmProvider,
} from "./config";
export { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "./client";

export function formatUsage(response: LlmResponse, durationMs: number): string {
  const usage = response.usage;
  return [
    "Feature-Rec LLM call:",
    `provider=${response.provider}`,
    `model=${response.model}`,
    `input_tokens=${usage?.inputTokens ?? "unknown"}`,
    `output_tokens=${usage?.outputTokens ?? "unknown"}`,
    `duration_ms=${Math.round(durationMs)}`,
  ].join(" ");
}

/** Anthropic keeps its native SDK; every other provider speaks the OpenAI chat format. */
export function createLlmClient(config: LlmConfig): LlmClient {
  const client =
    config.provider === "anthropic" ? createAnthropicClient(config) : createOpenAiCompatibleClient(config);
  return {
    async complete(req) {
      const started = performance.now();
      const response = await client.complete(req);
      console.log(formatUsage(response, performance.now() - started));
      return response;
    },
  };
}
