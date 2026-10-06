import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { emptyResponseError, llmFailure, type LlmClient, type LlmRequest, type LlmResponse } from "./client";
import type { LlmConfig } from "./config";

/** The slice of the Anthropic SDK this client uses; selftests pass a fake. */
export type AnthropicMessagesApi = {
  create(params: MessageCreateParamsNonStreaming): Promise<Message>;
};

export function anthropicClientOptions(config: LlmConfig) {
  // No baseURL: the SDK keeps honoring ANTHROPIC_BASE_URL as it did before.
  return { apiKey: config.apiKey, maxRetries: 2, timeout: config.timeoutMs };
}

export function buildAnthropicRequest(req: LlmRequest): MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  };
}

export function normalizeAnthropicMessage(
  message: Pick<Message, "content" | "stop_reason" | "usage">,
  model: string,
): LlmResponse {
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  const truncated = message.stop_reason === "max_tokens";
  if (!text && !truncated) throw emptyResponseError("anthropic", model);
  return {
    text,
    truncated,
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    provider: "anthropic",
    model,
  };
}

export function createAnthropicClient(
  config: LlmConfig,
  messages: AnthropicMessagesApi = new Anthropic(anthropicClientOptions(config)).messages,
): LlmClient {
  return {
    async complete(req) {
      let message: Message;
      try {
        message = await messages.create(buildAnthropicRequest(req));
      } catch (err) {
        throw llmFailure(err, { provider: "anthropic", model: req.model, apiKey: config.apiKey });
      }
      return normalizeAnthropicMessage(message, req.model);
    },
  };
}
