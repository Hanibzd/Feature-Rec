import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { anthropicClientOptions, createAnthropicClient } from "../src/anthropic";
import { llmFailure, redactSecrets } from "../src/client";
import { createOpenAiCompatibleClient, openAiClientOptions, stripThinking } from "../src/openai";
import { createLlmClient, formatUsage, LlmError, resolveLlmConfig, type LlmConfig } from "../src/index";

// Fake keys only; nothing here reaches the network.
const ANTHROPIC_KEY = "sk-ant-test-0000anthropic0000";
const OPENAI_KEY = "sk-test-0000openai0000wxyz";
const OPENROUTER_KEY = "sk-or-test-0000openrouter0000";

// Notices are logged once per process; capture them per resolution.
function resolve(env: NodeJS.ProcessEnv): { config: LlmConfig | null; notices: string[] } {
  const notices: string[] = [];
  const { log, warn } = console;
  console.log = (message: string) => notices.push(message);
  console.warn = (message: string) => notices.push(message);
  try {
    return { config: resolveLlmConfig(env), notices };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

// --- resolveLlmConfig ---------------------------------------------------------

// ANTHROPIC_API_KEY alone: today's exact behavior.
assert.deepEqual(resolve({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }).config, {
  provider: "anthropic",
  apiKey: ANTHROPIC_KEY,
  model: "claude-sonnet-4-6",
  classifierModel: "claude-sonnet-4-6",
  maxTokens: 16000,
  timeoutMs: 600000,
});

// No key, no provider: null keeps the heuristic path. Blank values count as unset
// because GitHub passes missing secrets as empty strings.
assert.equal(resolve({}).config, null);
assert.equal(resolve({ ANTHROPIC_API_KEY: "", FEATURE_REC_LLM_API_KEY: " " }).config, null);

// Auto-detection order: Anthropic, then OpenRouter, then OpenAI; the choice is logged.
{
  const { config, notices } = resolve({
    OPENAI_API_KEY: OPENAI_KEY,
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    FEATURE_REC_MODEL: "vendor/model",
  });
  assert.equal(config?.provider, "openrouter");
  assert.equal(config?.apiKey, OPENROUTER_KEY);
  assert.equal(config?.baseURL, "https://openrouter.ai/api/v1");
  assert.match(notices.join("\n"), /several LLM API keys found .*using openrouter/);
  assert.ok(!notices.join("\n").includes(OPENROUTER_KEY));
}
assert.equal(
  resolve({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY }).config?.provider,
  "anthropic",
);

// Explicit provider and generic key; the generic key wins over the specific one.
{
  const config = resolve({
    FEATURE_REC_LLM_PROVIDER: "openai",
    FEATURE_REC_LLM_API_KEY: "generic-key",
    OPENAI_API_KEY: OPENAI_KEY,
    FEATURE_REC_MODEL: "gpt-test",
    FEATURE_REC_CLASSIFIER_MODEL: "gpt-test-mini",
    FEATURE_REC_MAX_TOKENS: "8000",
    FEATURE_REC_LLM_TIMEOUT_MS: "1000",
  }).config;
  assert.deepEqual(config, {
    provider: "openai",
    apiKey: "generic-key",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-test",
    classifierModel: "gpt-test-mini",
    maxTokens: 8000,
    timeoutMs: 1000,
  });
}

// Configuration errors say what to add.
assert.throws(
  () => resolve({ FEATURE_REC_LLM_PROVIDER: "openrouter", OPENAI_API_KEY: OPENAI_KEY }),
  /no API key is set\. Set FEATURE_REC_LLM_API_KEY \(or OPENROUTER_API_KEY\)/,
);
assert.throws(
  () => resolve({ FEATURE_REC_LLM_API_KEY: "generic-key" }),
  /no provider is selected\. Set FEATURE_REC_LLM_PROVIDER/,
);
assert.throws(
  () => resolve({ FEATURE_REC_LLM_PROVIDER: "gemini", FEATURE_REC_LLM_API_KEY: "generic-key" }),
  /FEATURE_REC_LLM_PROVIDER must be one of anthropic, openai, openrouter, openai-compatible/,
);
assert.throws(
  () =>
    resolve({
      FEATURE_REC_LLM_PROVIDER: "openai-compatible",
      FEATURE_REC_LLM_API_KEY: "generic-key",
      FEATURE_REC_MODEL: "local-model",
    }),
  /needs FEATURE_REC_LLM_BASE_URL/,
);
assert.throws(
  () =>
    resolve({
      FEATURE_REC_LLM_PROVIDER: "openai-compatible",
      FEATURE_REC_LLM_API_KEY: "generic-key",
      FEATURE_REC_LLM_BASE_URL: "not a url",
      FEATURE_REC_MODEL: "local-model",
    }),
  /FEATURE_REC_LLM_BASE_URL must be an absolute URL/,
);
assert.equal(
  resolve({
    FEATURE_REC_LLM_PROVIDER: "openai-compatible",
    FEATURE_REC_LLM_API_KEY: "generic-key",
    FEATURE_REC_LLM_BASE_URL: "http://localhost:4000/v1",
    FEATURE_REC_MODEL: "local-model",
  }).config?.baseURL,
  "http://localhost:4000/v1",
);
assert.throws(
  () => resolve({ OPENROUTER_API_KEY: OPENROUTER_KEY }),
  /LLM provider "openrouter" needs FEATURE_REC_MODEL/,
);
for (const value of ["0", "-5", "12.5", "lots", "1e4"]) {
  assert.throws(
    () => resolve({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, FEATURE_REC_MAX_TOKENS: value }),
    (err: Error) => err.message === "FEATURE_REC_MAX_TOKENS must be a positive integer.",
  );
}
assert.throws(
  () => resolve({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, FEATURE_REC_LLM_TIMEOUT_MS: "soon" }),
  /FEATURE_REC_LLM_TIMEOUT_MS must be a positive integer/,
);

// Deprecated AUTODEMO_* aliases still apply, with a warning; the new names win.
{
  const { config, notices } = resolve({
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    AUTODEMO_MODEL: "claude-alias",
    AUTODEMO_MAX_TOKENS: "9000",
  });
  assert.equal(config?.model, "claude-alias");
  assert.equal(config?.classifierModel, "claude-alias");
  assert.equal(config?.maxTokens, 9000);
  assert.match(notices.join("\n"), /AUTODEMO_MODEL is deprecated; use FEATURE_REC_MODEL/);
  assert.match(notices.join("\n"), /AUTODEMO_MAX_TOKENS is deprecated; use FEATURE_REC_MAX_TOKENS/);
}
{
  const config = resolve({
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    FEATURE_REC_MODEL: "claude-new",
    AUTODEMO_MODEL: "claude-alias",
    FEATURE_REC_MAX_TOKENS: "7000",
    AUTODEMO_MAX_TOKENS: "9000",
  }).config;
  assert.equal(config?.model, "claude-new");
  assert.equal(config?.maxTokens, 7000);
}
assert.throws(
  () => resolve({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, AUTODEMO_MAX_TOKENS: "many" }),
  /AUTODEMO_MAX_TOKENS must be a positive integer/,
);

// Base URL is ignored for Anthropic so ANTHROPIC_BASE_URL keeps working through the SDK.
assert.equal(
  resolve({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, FEATURE_REC_LLM_BASE_URL: "https://proxy.test/v1" }).config
    ?.baseURL,
  undefined,
);

// Configuration errors never echo values, which could be a misplaced secret.
assert.throws(
  () => resolve({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, FEATURE_REC_MAX_TOKENS: OPENAI_KEY }),
  (err: Error) => !err.message.includes(OPENAI_KEY),
);

const anthropicConfig = resolve({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }).config!;
const openAiConfig = resolve({
  FEATURE_REC_LLM_PROVIDER: "openai",
  OPENAI_API_KEY: OPENAI_KEY,
  FEATURE_REC_MODEL: "gpt-test",
}).config!;
const openRouterConfig = resolve({ OPENROUTER_API_KEY: OPENROUTER_KEY, FEATURE_REC_MODEL: "vendor/model" })
  .config!;
const compatibleConfig = resolve({
  FEATURE_REC_LLM_PROVIDER: "openai-compatible",
  FEATURE_REC_LLM_API_KEY: "generic-key",
  FEATURE_REC_LLM_BASE_URL: "http://localhost:4000/v1",
  FEATURE_REC_MODEL: "local-model",
}).config!;
const request = { system: "SYSTEM", user: "USER", maxTokens: 16000, model: "the-model" };

// --- Anthropic ----------------------------------------------------------------

function anthropicMessage(content: Message["content"], stopReason: Message["stop_reason"]): Message {
  return {
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 11, output_tokens: 22 },
  } as Message;
}

function fakeAnthropic(reply: Message | Error) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      create: (params: MessageCreateParamsNonStreaming) => {
        calls.push(params);
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      },
    },
  };
}

{
  // Same request shape as the previous callClaude: system string, one user
  // message, no temperature, no stop sequences, no prefill.
  const fake = fakeAnthropic(
    anthropicMessage(
      [
        { type: "thinking", thinking: "```tsx\nnot this\n```", signature: "s" },
        { type: "text", text: "  part one, ", citations: null },
        { type: "text", text: "part two  ", citations: null },
      ] as Message["content"],
      "end_turn",
    ),
  );
  const response = await createAnthropicClient(anthropicConfig, fake.messages).complete(request);
  assert.deepEqual(fake.calls, [
    { model: "the-model", max_tokens: 16000, system: "SYSTEM", messages: [{ role: "user", content: "USER" }] },
  ]);
  assert.deepEqual(response, {
    text: "part one, part two",
    truncated: false,
    usage: { inputTokens: 11, outputTokens: 22 },
    provider: "anthropic",
    model: "the-model",
  });
  assert.deepEqual(anthropicClientOptions(anthropicConfig), {
    apiKey: ANTHROPIC_KEY,
    maxRetries: 2,
    timeout: 600000,
  });
}
{
  const fake = fakeAnthropic(
    anthropicMessage([{ type: "text", text: "```tsx\nexport const", citations: null }], "max_tokens"),
  );
  const response = await createAnthropicClient(anthropicConfig, fake.messages).complete(request);
  assert.equal(response.truncated, true);
}
await assert.rejects(
  () => createAnthropicClient(anthropicConfig, fakeAnthropic(anthropicMessage([], "end_turn")).messages).complete(request),
  /LLM returned no text content \(provider=anthropic, model=the-model\)/,
);
{
  const authError = new Anthropic.AuthenticationError(
    401,
    { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${ANTHROPIC_KEY}` } },
    undefined,
    new Headers({ "x-api-key": ANTHROPIC_KEY }),
  );
  const error = await createAnthropicClient(anthropicConfig, fakeAnthropic(authError).messages)
    .complete(request)
    .then(
      () => assert.fail("expected a rejection"),
      (err: unknown) => err,
    );
  assert.ok(error instanceof LlmError);
  assert.equal(error.status, 401);
  assert.equal(
    error.message,
    "LLM request failed (provider=anthropic, model=the-model, HTTP 401): invalid x-api-key [redacted]",
  );
  assert.ok(!`${error.message}\n${error.stack}`.includes(ANTHROPIC_KEY));
  assert.ok(!("cause" in error));
}

// --- OpenAI-compatible --------------------------------------------------------

function completion(content: string | null, finishReason: "stop" | "length"): ChatCompletion {
  return {
    choices: [{ index: 0, finish_reason: finishReason, logprobs: null, message: { role: "assistant", content, refusal: null } }],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  } as ChatCompletion;
}

function fakeOpenAi(reply: ChatCompletion | Error) {
  const calls: ChatCompletionCreateParamsNonStreaming[] = [];
  return {
    calls,
    completions: {
      create: (params: ChatCompletionCreateParamsNonStreaming) => {
        calls.push(params);
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      },
    },
  };
}

{
  const fake = fakeOpenAi(completion("hello", "stop"));
  const response = await createOpenAiCompatibleClient(openAiConfig, fake.completions).complete(request);
  assert.deepEqual(fake.calls, [
    {
      model: "the-model",
      messages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "USER" },
      ],
      max_completion_tokens: 16000,
    },
  ]);
  assert.deepEqual(response, {
    text: "hello",
    truncated: false,
    usage: { inputTokens: 5, outputTokens: 6 },
    provider: "openai",
    model: "the-model",
  });
}
for (const config of [openRouterConfig, compatibleConfig]) {
  const fake = fakeOpenAi(completion("hello", "stop"));
  await createOpenAiCompatibleClient(config, fake.completions).complete(request);
  const [params] = fake.calls;
  assert.equal(params?.max_tokens, 16000);
  assert.ok(!("max_completion_tokens" in params!));
  assert.ok(!("temperature" in params!));
}

// Client options: explicit retries and timeout, OpenRouter attribution headers only for OpenRouter.
assert.deepEqual(openAiClientOptions(openRouterConfig), {
  apiKey: OPENROUTER_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  maxRetries: 2,
  timeout: 600000,
  organization: null,
  project: null,
  defaultHeaders: { "HTTP-Referer": "https://feature-rec.com", "X-Title": "Feature-Rec" },
});
assert.deepEqual(openAiClientOptions(openAiConfig), {
  apiKey: OPENAI_KEY,
  baseURL: "https://api.openai.com/v1",
  maxRetries: 2,
  timeout: 600000,
});
assert.equal(openAiClientOptions(compatibleConfig).defaultHeaders, undefined);

// Response normalization.
assert.equal(
  stripThinking("<think>plan:\n```tsx\nwrong\n```</think>\nanswer<THINK>more</THINK>"),
  "\nanswer",
);
{
  const fake = fakeOpenAi(completion("<think>\n```tsx\nwrong\n```\n</think>\n\n```tsx\nright\n```", "stop"));
  const response = await createOpenAiCompatibleClient(openRouterConfig, fake.completions).complete(request);
  assert.equal(response.text, "```tsx\nright\n```");
}
for (const content of [null, "", "<think>only reasoning</think>"]) {
  await assert.rejects(
    () => createOpenAiCompatibleClient(openRouterConfig, fakeOpenAi(completion(content, "stop")).completions).complete(request),
    /LLM returned no text content \(provider=openrouter, model=the-model\)/,
  );
}
await assert.rejects(
  () =>
    createOpenAiCompatibleClient(openRouterConfig, fakeOpenAi({ choices: [] } as unknown as ChatCompletion).completions)
      .complete(request),
  /LLM returned no text content/,
);
{
  const fake = fakeOpenAi(completion("```tsx\nexport const", "length"));
  const response = await createOpenAiCompatibleClient(openRouterConfig, fake.completions).complete(request);
  assert.equal(response.truncated, true);
}

// A 401 echoing a masked key never leaks the key or its visible suffix.
{
  const authError = new OpenAI.AuthenticationError(
    401,
    { message: "Incorrect API key provided: sk-test-****wxyz. You can find your API key at https://platform.openai.com." },
    undefined,
    new Headers({ authorization: `Bearer ${OPENAI_KEY}` }),
  );
  const error = await createOpenAiCompatibleClient(openAiConfig, fakeOpenAi(authError).completions)
    .complete(request)
    .then(
      () => assert.fail("expected a rejection"),
      (err: unknown) => err,
    );
  assert.ok(error instanceof LlmError);
  assert.equal(error.status, 401);
  assert.match(error.message, /^LLM request failed \(provider=openai, model=the-model, HTTP 401\): Incorrect API key provided: \[redacted\]/);
  const shown = `${error.message}\n${error.stack}`;
  assert.ok(!shown.includes(OPENAI_KEY));
  assert.ok(!shown.includes("wxyz"));
}
{
  const timeout = new OpenAI.APIConnectionTimeoutError();
  const error = await createOpenAiCompatibleClient(compatibleConfig, fakeOpenAi(timeout).completions)
    .complete(request)
    .then(
      () => assert.fail("expected a rejection"),
      (err: unknown) => err,
    );
  assert.ok(error instanceof LlmError);
  assert.equal(error.status, undefined);
  assert.match(error.message, /^LLM request failed \(provider=openai-compatible, model=the-model\): Request timed out/);
}
// A key straddling the 500-character clip is still fully redacted.
{
  const longKey = "plain-long-fake-key-0123456789abcdefghij";
  const error = llmFailure(new OpenAI.BadRequestError(400, { message: `${"x".repeat(490)}${longKey}` }, undefined, new Headers()), {
    provider: "openai-compatible",
    model: "the-model",
    apiKey: longKey,
  });
  assert.ok(!error.message.includes(longKey.slice(0, 10)));
}
assert.equal(
  redactSecrets(`key=${OPENAI_KEY} header Bearer abc.def masked or-****1234`, OPENAI_KEY),
  "key=[redacted] header Bearer [redacted] masked [redacted]",
);

// --- createLlmClient ----------------------------------------------------------

assert.equal(
  formatUsage({ text: "x", truncated: false, provider: "openrouter", model: "vendor/model" }, 1234.4),
  "Feature-Rec LLM call: provider=openrouter model=vendor/model input_tokens=unknown output_tokens=unknown duration_ms=1234",
);
assert.equal(typeof createLlmClient(anthropicConfig).complete, "function");
assert.equal(typeof createLlmClient(openRouterConfig).complete, "function");

console.log("llm selftest passed");
