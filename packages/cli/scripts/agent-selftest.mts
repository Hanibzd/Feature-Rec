/* Self-test for the agent's LLM wiring (not part of the build). No network: fake clients only. */
import fs from "node:fs";
import path from "node:path";
import { LlmError, type LlmClient, type LlmConfig, type LlmRequest, type LlmResponse } from "@feature-rec/llm";
import type { Feature } from "../src/analyze.ts";
import { repairScenes, replicate } from "../src/agent/index.ts";
import { callLlm } from "../src/agent/llm.ts";
import { GENERATED_DIR } from "../src/paths.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}
async function rejection(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

const config: LlmConfig = {
  provider: "openrouter",
  apiKey: "fake-key-for-selftest",
  baseURL: "https://openrouter.ai/api/v1",
  model: "vendor/scene-model",
  classifierModel: "vendor/small-model",
  maxTokens: 16000,
  timeoutMs: 1000,
};
function fakeClient(reply: Partial<LlmResponse> | Error): { client: LlmClient; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    client: {
      complete: (req) => {
        requests.push(req);
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve({ text: "", truncated: false, provider: config.provider, model: req.model, ...reply });
      },
    },
  };
}

{
  const fake = fakeClient({ text: "scene" });
  const text = await callLlm(fake.client, config, { system: "SYSTEM", cached: "KIT", turns: [{ role: "user", content: "PROMPT" }] });
  ok("callLlm returns the response text", text === "scene");
  ok(
    "callLlm sends the scene model and FEATURE_REC_MAX_TOKENS",
    JSON.stringify(fake.requests) ===
      JSON.stringify([{ system: "SYSTEM", cached: "KIT", turns: [{ role: "user", content: "PROMPT" }], model: "vendor/scene-model", maxTokens: 16000 }]),
  );
}

{
  const err = await rejection(() =>
    callLlm(fakeClient({ text: "```tsx\nexport const", truncated: true }).client, config, { system: "", turns: [{ role: "user", content: "" }] }),
  );
  ok(
    "truncation raises an explicit error that names FEATURE_REC_MAX_TOKENS",
    err?.message ===
      "Agent response was truncated at 16000 output tokens (provider=openrouter, model=vendor/scene-model). Raise FEATURE_REC_MAX_TOKENS or simplify the change.",
  );
}

{
  const badRequest = new LlmError("LLM request failed (provider=openrouter, model=vendor/scene-model, HTTP 400): max_tokens too large", {
    provider: "openrouter",
    model: "vendor/scene-model",
    status: 400,
  });
  const err = await rejection(() => callLlm(fakeClient(badRequest).client, config, { system: "", turns: [{ role: "user", content: "" }] }));
  ok(
    "a provider 400 keeps the API message and adds the model and FEATURE_REC_MAX_TOKENS hint",
    err instanceof LlmError &&
      err.message.startsWith(badRequest.message) &&
      err.message.includes("If vendor/scene-model caps output below 16000 tokens, lower FEATURE_REC_MAX_TOKENS."),
  );
}

{
  const unauthorized = new LlmError("LLM request failed (provider=openrouter, model=vendor/scene-model, HTTP 401): bad key", {
    provider: "openrouter",
    model: "vendor/scene-model",
    status: 401,
  });
  const err = await rejection(() => callLlm(fakeClient(unauthorized).client, config, { system: "", turns: [{ role: "user", content: "" }] }));
  ok("other provider errors propagate unchanged", err === unauthorized);
}

// replicate(): configuration resolution and offline short-circuit. None of
// these paths writes a scene file or reaches the network.
const llmVariables = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "FEATURE_REC_LLM_API_KEY",
  "FEATURE_REC_LLM_PROVIDER",
  "FEATURE_REC_LLM_BASE_URL",
  "FEATURE_REC_MODEL",
  "FEATURE_REC_MAX_TOKENS",
  "FEATURE_REC_CLASSIFIER_MODEL",
  "FEATURE_REC_LLM_TIMEOUT_MS",
  "AUTODEMO_MODEL",
  "AUTODEMO_MAX_TOKENS",
];
const savedEnv = Object.fromEntries(llmVariables.map((name) => [name, process.env[name]]));
for (const name of llmVariables) delete process.env[name];

const feature = (id: string): Feature => ({
  id,
  file: "src/App.tsx",
  prTitle: "Change",
  prNumber: 1,
  releaseTag: "PR #1",
  productName: "Feature-Rec",
  description: "Change",
  caption: "Change",
  before: "",
  after: "",
});
const tokens = { tailwindConfig: "", globalsCss: "" };

try {
  const result = await replicate(feature("dark-mode-toggle"), tokens);
  ok("no key: known-good scene is used", result.source === "offline" && !result.wrote);

  const missing = await rejection(() => replicate(feature("no-known-good-scene"), tokens));
  ok(
    "no key and no known-good scene: error lists the accepted key variables",
    missing?.message.includes("FEATURE_REC_LLM_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY") ===
      true,
  );

  process.env.FEATURE_REC_LLM_PROVIDER = "openrouter";
  const misconfigured = await rejection(() => replicate(feature("dark-mode-toggle"), tokens));
  ok(
    "explicit provider without key fails instead of silently using the known-good scene",
    misconfigured?.message.includes("no API key is set") === true,
  );
  const offline = await replicate(feature("dark-mode-toggle"), tokens, { offline: true });
  ok("offline mode skips LLM configuration entirely", offline.source === "offline");

  // Exercise the SDK and orchestration without a network connection. A validation
  // failure and a render failure must retain the previous assistant response.
  const id = "zz-agent-repair-selftest";
  const scenePath = path.join(GENERATED_DIR, `${id}.tsx`);
  const savedScene = fs.existsSync(scenePath) ? fs.readFileSync(scenePath) : null;
  const savedFetch = globalThis.fetch;
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const scene = 'import { z } from "zod";\nexport const schema = z.object({});\nexport default function Scene() { return <div />; }';
  const goodReply = `\`\`\`tsx\n${scene}\n\`\`\``;
  process.env.FEATURE_REC_LLM_PROVIDER = "openai-compatible";
  process.env.FEATURE_REC_LLM_API_KEY = "fake-agent-test-key";
  process.env.FEATURE_REC_LLM_BASE_URL = "https://llm.invalid/v1";
  process.env.FEATURE_REC_MODEL = "scene-test-model";
  globalThis.fetch = (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as typeof requests[number]);
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: requests.length === 1 ? "invalid scene" : goodReply }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } }));
  };
  try {
    const generated = await replicate(feature(id), tokens);
    ok("compatible provider repairs validation failures and writes the scene", generated.source === "llm" && generated.wrote && !generated.real && fs.readFileSync(scenePath, "utf8").trim() === scene);
    const validationRepair = requests[1]?.messages;
    ok("validation repair retains the prompt, assistant response and error", requests.length === 2 && validationRepair?.length === 4 && validationRepair[1].content === requests[0].messages[1].content && validationRepair[2].content === "invalid scene" && validationRepair[3].content.includes("No tsx code block"));
    const repaired = await repairScenes(`Render failed for ${id}: test failure`);
    const renderRepair = requests[2]?.messages;
    ok("render repair uses the same provider conversation", repaired.includes(id) && renderRepair?.length === 6 && renderRepair[4].content === goodReply && renderRepair[5].content.includes("test failure"));
  } finally {
    globalThis.fetch = savedFetch;
    if (savedScene === null) fs.rmSync(scenePath, { force: true });
    else fs.writeFileSync(scenePath, savedScene);
  }
} finally {
  for (const name of llmVariables) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
