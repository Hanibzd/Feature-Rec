import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = process.env.AUTODEMO_MODEL ?? "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = Number(process.env.AUTODEMO_MAX_TOKENS) || 16000;

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Single-shot call to Claude. Returns the concatenated text content. */
export async function callClaude(opts: {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
}): Promise<string> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const message = await client.messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });

  // A truncated response loses its closing code fence — fail loudly so the caller
  // can fall back instead of writing a half-finished scene.
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      "Agent response was truncated (hit max_tokens). Raise AUTODEMO_MAX_TOKENS or simplify the change.",
    );
  }

  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}
