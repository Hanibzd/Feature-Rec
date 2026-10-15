import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
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

const saved = { ...process.env };
const backendOnly = { files: ["packages/service/src/http.ts"], patch: "+ const x = 1;", prTitle: "Backend change" };
const uiChange = { files: ["apps/web/components/Button.tsx"], patch: "+ className", prTitle: "Change button" };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER;
await assert.rejects(() => classifyFrontendVisible(uiChange), /ANTHROPIC_API_KEY is required/);

// Fake Anthropic Messages API. A provider failure (invalid key, exhausted
// credit, spend limit, outage) must not fail the check on PRs without UI
// changes, so the classifier falls back to the filename heuristic.
let providerResponse: { status: number; body: unknown; headers?: Record<string, string> } = { status: 500, body: {} };
const providerRequests: { apiKey?: string; model?: string }[] = [];
const provider = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "null") as { model?: string } | null;
    providerRequests.push({ apiKey: request.headers["x-api-key"] as string | undefined, model: body?.model });
    // Status 0 simulates an outage at the transport level: the connection drops.
    if (providerResponse.status === 0) {
      request.socket.destroy();
      return;
    }
    response.writeHead(providerResponse.status, { "content-type": "application/json", ...providerResponse.headers });
    response.end(JSON.stringify(providerResponse.body));
  })().catch((error: unknown) => { response.destroy(error as Error); });
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerAddress = provider.address();
assert.ok(providerAddress && typeof providerAddress !== "string");
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${providerAddress.port}`;
process.env.ANTHROPIC_API_KEY = "test-key";

const invalidKey401 = {
  status: 401,
  body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
};

try {
  // Invalid key (401): the heuristic decides, and the result says why, so the
  // accepted check summary tells the customer that the key is broken.
  providerResponse = invalidKey401;
  const invalidKey = await classifyFrontendVisible(backendOnly);
  assert.equal(invalidKey.frontendVisible, false);
  assert.equal(invalidKey.providerError, "Anthropic API error 401 (authentication_error): invalid x-api-key");
  assert.match(invalidKey.reason, /No changed files look like frontend\/UI sources/);
  assert.match(invalidKey.reason, /401 \(authentication_error\): invalid x-api-key/);
  assert.equal(providerRequests.at(-1)?.apiKey, "test-key");

  // Exhausted credit or spend limit (400 invalid_request_error) falls back too.
  providerResponse = {
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
  };
  const noCredit = await classifyFrontendVisible(backendOnly);
  assert.equal(noCredit.frontendVisible, false);
  assert.equal(noCredit.providerError, "Anthropic API error 400 (invalid_request_error): Your credit balance is too low to access the Anthropic API.");

  // Provider outage (529 overloaded). The header skips the SDK's retries so the
  // test stays fast; the fallback does not depend on it.
  providerResponse = {
    status: 529,
    headers: { "x-should-retry": "false" },
    body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  };
  const overloaded = await classifyFrontendVisible(backendOnly);
  assert.equal(overloaded.frontendVisible, false);
  assert.equal(overloaded.providerError, "Anthropic API error 529 (overloaded_error): Overloaded");

  // Dropped connections (retried by the SDK, then surfaced without a status).
  providerResponse = { status: 0, body: null };
  const dropped = await classifyFrontendVisible(backendOnly);
  assert.equal(dropped.frontendVisible, false);
  // No HTTP status: the marker starts with the plain prefix and the SDK's text.
  assert.match(dropped.providerError ?? "", /^Anthropic API error: \S/);
  assert.match(dropped.reason, /Claude could not classify this PR/);

  // UI candidates under a provider failure: the classifier reports them as
  // frontend-visible with the cause attached, and the caller decides.
  providerResponse = invalidKey401;
  const uiUnderFailure = await classifyFrontendVisible(uiChange);
  assert.equal(uiUnderFailure.frontendVisible, true);
  assert.deepEqual(uiUnderFailure.files, ["apps/web/components/Button.tsx"]);
  assert.equal(uiUnderFailure.providerError, "Anthropic API error 401 (authentication_error): invalid x-api-key");
  assert.match(uiUnderFailure.reason, /Changed files include frontend\/UI candidates\. Claude could not classify this PR/);

  // A healthy provider answers normally, with no fallback marker.
  const verdict = { frontendVisible: true, confidence: 0.9, reason: "Button copy changed.", userImpact: "New label.", files: ["apps/web/components/Button.tsx"] };
  providerResponse = {
    status: 200,
    body: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { input_tokens: 1, output_tokens: 1 } },
  };
  assert.deepEqual(await classifyFrontendVisible(uiChange), verdict);

  // A truncated or malformed answer is not a provider failure: it fails the run.
  providerResponse = { status: 200, body: { ...(providerResponse.body as object), stop_reason: "max_tokens" } };
  await assert.rejects(() => classifyFrontendVisible(uiChange), /truncated/);
  providerResponse = { status: 200, body: { ...(providerResponse.body as object), stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] } };
  await assert.rejects(() => classifyFrontendVisible(uiChange), /no JSON object/);
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  provider.closeAllConnections();
  await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
}

console.log("action selftest passed");
