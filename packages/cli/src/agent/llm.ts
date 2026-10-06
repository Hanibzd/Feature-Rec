import { LlmError, type LlmClient, type LlmConfig } from "@feature-rec/llm";

/** Single-shot scene-generation call. Returns the response text. */
export async function callLlm(
  client: LlmClient,
  config: LlmConfig,
  opts: { system: string; prompt: string },
): Promise<string> {
  let response;
  try {
    response = await client.complete({
      system: opts.system,
      user: opts.prompt,
      model: config.model,
      maxTokens: config.maxTokens,
    });
  } catch (err) {
    // Providers do not flag an output cap above the model's limit distinctly;
    // a 400 is the usual symptom when a model caps output below 16000 tokens.
    if (err instanceof LlmError && err.status === 400) {
      throw new LlmError(
        `${err.message} If ${config.model} caps output below ${config.maxTokens} tokens, lower FEATURE_REC_MAX_TOKENS.`,
        { provider: err.provider, model: err.model, status: err.status },
      );
    }
    throw err;
  }

  // A truncated response loses its closing code fence — fail loudly so the caller
  // can fall back instead of writing a half-finished scene.
  if (response.truncated) {
    throw new Error(
      `Agent response was truncated at ${config.maxTokens} output tokens (provider=${response.provider}, model=${response.model}). Raise FEATURE_REC_MAX_TOKENS or simplify the change.`,
    );
  }
  return response.text;
}
