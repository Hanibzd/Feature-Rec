export const LLM_PROVIDERS = ["anthropic", "openai", "openrouter", "openai-compatible"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  /** Only used by the OpenAI-compatible family; always set for it. */
  baseURL?: string;
  /** Scene-generation model. */
  model: string;
  classifierModel: string;
  maxTokens: number;
  timeoutMs: number;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 16000;
// Matches the SDKs' own default, so Anthropic-only clients keep today's timeout.
export const DEFAULT_TIMEOUT_MS = 600_000;

export const LLM_API_KEY_VARIABLES = [
  "FEATURE_REC_LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;
export const API_KEY_VARIABLES =
  "FEATURE_REC_LLM_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY";

const PROVIDER_KEY_VARIABLE: Record<LlmProvider, string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "openai-compatible": undefined,
};

// Anthropic first: existing clients that only pass ANTHROPIC_API_KEY must keep
// exactly the same provider even if another key is present in the environment.
const AUTO_DETECT_ORDER: readonly LlmProvider[] = ["anthropic", "openrouter", "openai"];

const DEFAULT_BASE_URL: Partial<Record<LlmProvider, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

// The Action resolves the config once for the classifier and again for the
// agent in the same process; notices are logged once per process.
const emittedNotices = new Set<string>();
function noticeOnce(level: "log" | "warn", message: string): void {
  if (emittedNotices.has(message)) return;
  emittedNotices.add(message);
  console[level](message);
}

/** GitHub passes unset secrets as empty strings, so blank means unset. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function isProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function deprecatedAlias(env: NodeJS.ProcessEnv, alias: string, name: string): string | undefined {
  const value = read(env, alias);
  if (value === undefined) return undefined;
  if (read(env, name) !== undefined) {
    noticeOnce("warn", `Feature-Rec: ${alias} is deprecated and ignored because ${name} is set.`);
    return undefined;
  }
  noticeOnce("warn", `Feature-Rec: ${alias} is deprecated; use ${name} instead.`);
  return value;
}

function keyHint(provider: LlmProvider): string {
  const specific = PROVIDER_KEY_VARIABLE[provider];
  return specific ? `FEATURE_REC_LLM_API_KEY (or ${specific})` : "FEATURE_REC_LLM_API_KEY";
}

/**
 * Resolve the LLM configuration from environment variables only.
 * Returns null when no key and no provider are configured, which keeps the
 * heuristic classifier and known-good scenes as the only paths.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv): LlmConfig | null {
  const explicitProvider = read(env, "FEATURE_REC_LLM_PROVIDER");
  const genericKey = read(env, "FEATURE_REC_LLM_API_KEY");

  let provider: LlmProvider;
  if (explicitProvider !== undefined) {
    if (!isProvider(explicitProvider)) {
      throw new Error(
        `FEATURE_REC_LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(", ")}.`,
      );
    }
    provider = explicitProvider;
  } else {
    const detected = AUTO_DETECT_ORDER.filter((candidate) => {
      const variable = PROVIDER_KEY_VARIABLE[candidate];
      return variable !== undefined && read(env, variable) !== undefined;
    });
    const [first] = detected;
    if (first === undefined) {
      if (genericKey !== undefined) {
        throw new Error(
          `FEATURE_REC_LLM_API_KEY is set but no provider is selected. Set FEATURE_REC_LLM_PROVIDER to one of ${LLM_PROVIDERS.join(", ")}.`,
        );
      }
      return null;
    }
    if (detected.length > 1) {
      noticeOnce(
        "log",
        `Feature-Rec: several LLM API keys found (${detected.map((p) => PROVIDER_KEY_VARIABLE[p]).join(", ")}); using ${first}. Set FEATURE_REC_LLM_PROVIDER to choose another.`,
      );
    }
    provider = first;
  }

  const specificVariable = PROVIDER_KEY_VARIABLE[provider];
  const apiKey = genericKey ?? (specificVariable ? read(env, specificVariable) : undefined);
  if (apiKey === undefined) {
    throw new Error(
      `FEATURE_REC_LLM_PROVIDER is "${provider}" but no API key is set. Set ${keyHint(provider)} (Action input \`llm-api-key\`).`,
    );
  }

  let baseURL: string | undefined;
  const configuredBaseURL = read(env, "FEATURE_REC_LLM_BASE_URL");
  if (provider === "anthropic") {
    if (configuredBaseURL !== undefined) {
      noticeOnce(
        "warn",
        "Feature-Rec: FEATURE_REC_LLM_BASE_URL only applies to OpenAI-compatible providers; ignored for anthropic.",
      );
    }
  } else {
    baseURL = configuredBaseURL ?? DEFAULT_BASE_URL[provider];
    if (baseURL === undefined) {
      throw new Error(
        `LLM provider "${provider}" needs FEATURE_REC_LLM_BASE_URL (Action input \`llm-base-url\`), e.g. https://host/v1.`,
      );
    }
    if (!URL.canParse(baseURL)) {
      throw new Error("FEATURE_REC_LLM_BASE_URL must be an absolute URL, e.g. https://host/v1.");
    }
  }

  const modelAlias = deprecatedAlias(env, "AUTODEMO_MODEL", "FEATURE_REC_MODEL");
  const model =
    read(env, "FEATURE_REC_MODEL") ??
    modelAlias ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : undefined);
  if (model === undefined) {
    // No default model outside Anthropic: provider model ids go stale too fast.
    throw new Error(
      `LLM provider "${provider}" needs FEATURE_REC_MODEL (Action input \`model\`) set to the provider's model id.`,
    );
  }

  const maxTokensAlias = deprecatedAlias(env, "AUTODEMO_MAX_TOKENS", "FEATURE_REC_MAX_TOKENS");
  const maxTokens =
    maxTokensAlias === undefined
      ? positiveInteger("FEATURE_REC_MAX_TOKENS", read(env, "FEATURE_REC_MAX_TOKENS"), DEFAULT_MAX_TOKENS)
      : positiveInteger("AUTODEMO_MAX_TOKENS", maxTokensAlias, DEFAULT_MAX_TOKENS);

  return {
    provider,
    apiKey,
    ...(baseURL === undefined ? {} : { baseURL }),
    model,
    classifierModel: read(env, "FEATURE_REC_CLASSIFIER_MODEL") ?? model,
    maxTokens,
    timeoutMs: positiveInteger(
      "FEATURE_REC_LLM_TIMEOUT_MS",
      read(env, "FEATURE_REC_LLM_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    ),
  };
}
