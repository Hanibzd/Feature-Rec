import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = process.env.AUTODEMO_MODEL ?? "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = Number(process.env.AUTODEMO_MAX_TOKENS) || 16000;

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export type Turn = { role: "user" | "assistant"; content: string };

/**
 * One call to Claude over a (possibly multi-turn) conversation. Returns the text content.
 *
 * `system` and `cached` are identical across scenes and pull requests, so both are marked as
 * prompt-cache breakpoints: `cached` is sent as the first block of the first user turn, ahead
 * of the request-specific text. Repair turns (the scene's error fed back) reuse the cache too.
 */
export async function callClaude(opts: {
  system: string;
  cached?: string;
  turns: Turn[];
  model?: string;
  maxTokens?: number;
}): Promise<string> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const messages: Anthropic.MessageParam[] = opts.turns.map((turn, i) =>
    i === 0 && turn.role === "user" && opts.cached
      ? {
          role: "user",
          content: [
            { type: "text", text: opts.cached, cache_control: { type: "ephemeral" } },
            { type: "text", text: turn.content },
          ],
        }
      : { role: turn.role, content: turn.content },
  );
  const message = await client.messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages,
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
