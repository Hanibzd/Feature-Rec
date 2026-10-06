import type { LlmProvider } from "./config";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  model: string;
}

export interface LlmResponse {
  text: string;
  /** The provider stopped at the output-token cap (Anthropic "max_tokens", OpenAI "length"). */
  truncated: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  provider: LlmProvider;
  model: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Provider failure rewritten to a short message. Every exception ends up in the
 * PR check run through failCycle, so it carries no SDK error object (headers,
 * request options) and no `cause` that a logger could expand.
 */
export class LlmError extends Error {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly status: number | undefined;

  constructor(message: string, details: { provider: LlmProvider; model: string; status?: number }) {
    super(message);
    this.name = "LlmError";
    this.provider = details.provider;
    this.model = details.model;
    this.status = details.status;
  }
}

const MAX_API_MESSAGE_LENGTH = 500;

/** Remove the key and anything that looks like a key or a masked key from provider text. */
export function redactSecrets(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join("[redacted]") : text;
  return (
    withoutKey
      // Providers echo masked keys such as "sk-proj-****abcd"; the visible
      // suffix is still a key fragment.
      .replace(/\S*\*{3,}\S*/g, "[redacted]")
      .replace(/\bsk-[^\s"',]+/gi, "[redacted]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
  );
}

/** The API's own message: `error.message` (OpenAI) or `error.error.message` (Anthropic body). */
function bodyMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { message, error } = body as { message?: unknown; error?: unknown };
  if (typeof message === "string" && message) return message;
  return bodyMessage(error);
}

export function llmFailure(
  err: unknown,
  context: { provider: LlmProvider; model: string; apiKey: string },
): LlmError {
  const rawStatus = (err as { status?: unknown } | null)?.status;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const raw = err instanceof Error ? err.message : String(err);
  // Both SDKs format API errors as "<status> <API message or JSON body>".
  // Redact before clipping: a key cut in half would no longer match.
  const apiMessage = redactSecrets(
    bodyMessage((err as { error?: unknown } | null)?.error) ??
      (status === undefined ? raw : raw.replace(new RegExp(`^${status}\\s+`), "")),
    context.apiKey,
  );
  const clipped =
    apiMessage.length > MAX_API_MESSAGE_LENGTH ? `${apiMessage.slice(0, MAX_API_MESSAGE_LENGTH)}…` : apiMessage;
  const where = [`provider=${context.provider}`, `model=${context.model}`];
  if (status !== undefined) where.push(`HTTP ${status}`);
  return new LlmError(`LLM request failed (${where.join(", ")}): ${clipped}`, {
    provider: context.provider,
    model: context.model,
    ...(status === undefined ? {} : { status }),
  });
}

export function emptyResponseError(provider: LlmProvider, model: string): LlmError {
  return new LlmError(`LLM returned no text content (provider=${provider}, model=${model}).`, {
    provider,
    model,
  });
}
