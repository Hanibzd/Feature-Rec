import assert from "node:assert/strict";
import { classifyFrontendVisible, extractClassifierJson } from "../src/classifier";
import { collectDiffContext, heuristicFrontendVisible } from "../src/diff";

assert.equal(
  heuristicFrontendVisible(["README.md", ".github/workflows/ci.yaml"], "").frontendVisible,
  false,
);
assert.equal(
  heuristicFrontendVisible(["apps/web/components/Button.tsx"], "+ className").frontendVisible,
  true,
);
assert.equal(typeof collectDiffContext, "function");
assert.deepEqual(
  extractClassifierJson('```json\n{"frontendVisible":false,"confidence":0.9}\n```'),
  { frontendVisible: false, confidence: 0.9 },
);

// Isolate the classifier from LLM settings in the developer's shell.
const llmVariables = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "FEATURE_REC_LLM_API_KEY",
  "FEATURE_REC_LLM_PROVIDER",
  "FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER",
];
const savedEnv = Object.fromEntries(llmVariables.map((name) => [name, process.env[name]]));
for (const name of llmVariables) delete process.env[name];

const uiChange = { files: ["apps/web/components/Button.tsx"], patch: "+ className", prTitle: "Change button" };
const docsChange = { files: ["README.md"], patch: "+ docs", prTitle: "Docs" };

// No key and no provider: the heuristic path is unchanged.
await assert.rejects(() => classifyFrontendVisible(uiChange), /An LLM API key is required/);
assert.equal((await classifyFrontendVisible(docsChange)).frontendVisible, false);
process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER = "1";
assert.equal((await classifyFrontendVisible(uiChange)).frontendVisible, true);
delete process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER;

// An explicit provider without a key is a configuration error, never a silent
// fallback to the heuristic, even for a change the heuristic would accept.
process.env.FEATURE_REC_LLM_PROVIDER = "openrouter";
await assert.rejects(() => classifyFrontendVisible(docsChange), /no API key is set\. Set FEATURE_REC_LLM_API_KEY/);
delete process.env.FEATURE_REC_LLM_PROVIDER;

for (const name of llmVariables) {
  const value = savedEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("action selftest passed");
