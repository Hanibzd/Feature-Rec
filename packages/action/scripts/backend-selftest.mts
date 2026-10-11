import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { acceptCycle, failCycle, SettledBackendError, startCycle, uploadVideo } from "../src/backend";

const run = promisify(execFile);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "feature-rec-action-"));
const videoPath = path.join(temporary, "video.mp4");
await fs.writeFile(videoPath, new Uint8Array([1, 2, 3]));
const saved = { ...process.env };
let issued = 0;
const calls: { path: string; token?: string; body: string; attempt?: string }[] = [];
let startResponse: object = { cycleId: "cycle-a", cycleKey: "tenant-a/1#7:abc1234", attemptId: "attempt-a" };
let backendStatus = 200;
let settledFailure = false;
let apiUrl = "";
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/oidc") {
      assert.equal(url.searchParams.get("audience"), apiUrl);
      assert.equal(request.headers.authorization, "Bearer request-credential");
      response.end(JSON.stringify({ value: `fresh-oidc-${++issued}` }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    // Fake Anthropic Messages API with a broken key, reached through
    // ANTHROPIC_BASE_URL. Provider calls are not backend calls.
    if (url.pathname === "/v1/messages") {
      response.writeHead(401).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      return;
    }
    calls.push({ path: url.pathname, token: request.headers.authorization, body, attempt: request.headers["x-feature-rec-attempt"] as string | undefined });
    if (url.pathname.endsWith("/start")) response.end(JSON.stringify(startResponse));
    else response.writeHead(backendStatus).end(JSON.stringify(settledFailure
      ? { settled: true, error: "video_delivery_failed", message: "Video delivery failed. Rerun the workflow." }
      : backendStatus === 200 ? { ok: true } : { error: "OIDC audience rejected" }));
  })().catch((error: unknown) => { response.destroy(error as Error); });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
apiUrl = `http://127.0.0.1:${address.port}`;
process.env.NODE_ENV = "test";
process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-credential";
process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `${apiUrl}/oidc?request=test`;

try {
  const started = await startCycle(`${apiUrl}///`, { prNumber: 7, headSha: "abc1234", owner: "untrusted", tenantId: "untrusted", prTitle: "untrusted" } as never);
  assert.deepEqual(started, startResponse);
  const classifier = { frontendVisible: false, confidence: 1, reason: "test", userImpact: "", files: [] };
  await acceptCycle(apiUrl, "cycle-a", classifier, "attempt-a");
  await failCycle(apiUrl, "cycle-a", "render failed", "attempt-a");
  // Simulate a completed render: upload must request another token now.
  await uploadVideo(apiUrl, "cycle-a", videoPath, "attempt-a");
  assert.equal(issued, 4);
  assert.deepEqual(calls.map(call => call.token), [1, 2, 3, 4].map(number => `Bearer fresh-oidc-${number}`));
  assert.deepEqual(JSON.parse(calls[0].body), { prNumber: 7, headSha: "abc1234" });
  assert.equal(JSON.parse(calls[1].body).attemptId, "attempt-a");
  assert.equal(JSON.parse(calls[2].body).attemptId, "attempt-a");
  assert.equal(calls[3].attempt, "attempt-a");
  assert.equal(calls[3].body, "\u0001\u0002\u0003");

  // Unexpected server errors may already have settled the cycle. Preserve
  // that signal so the Action's catch skips its /failed callback.
  for (const status of [500, 503]) {
    backendStatus = status;
    settledFailure = true;
    await assert.rejects(uploadVideo(apiUrl, "cycle-a", videoPath, "attempt-a"), (error: unknown) => {
      assert.ok(error instanceof SettledBackendError);
      assert.equal(error.message, "Video delivery failed. Rerun the workflow.");
      return true;
    });
  }
  backendStatus = 200;
  settledFailure = false;

  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  await assert.rejects(startCycle(apiUrl, { prNumber: 7, headSha: "abc1234" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /id-token: write/);
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
    return true;
  });
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-credential";
  backendStatus = 401;
  await assert.rejects(acceptCycle(apiUrl, "cycle-a", classifier, "attempt-a"), /accepted failed: 401.*OIDC audience rejected/);
  backendStatus = 200;

  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const actionRoot = path.resolve(import.meta.dirname, "..");
  const { stdout: head } = await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const eventPath = path.join(temporary, "event.json");
  await fs.writeFile(eventPath, JSON.stringify({
    action: "synchronize", repository: { name: "ignored", owner: { login: "ignored" } },
    pull_request: { number: 7, state: "open", draft: false, title: "Change", user: { login: "ignored" }, base: { sha: head.trim() }, head: { sha: head.trim() } },
  }));
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER;
  const runAction = () => run(process.execPath, ["--import", "tsx", "src/index.ts", "--repo", repoRoot, "--event", eventPath, "--api-url", apiUrl], { cwd: actionRoot, env: childEnv });

  // A fixture repository whose heads each change one file: a stylesheet
  // (frontend candidate without renderable source), a TSX component, and a
  // backend module. Every head branches from the same base commit.
  const fixtureRepo = path.join(temporary, "repo");
  await fs.mkdir(path.join(fixtureRepo, "src/components"), { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "selftest", GIT_AUTHOR_EMAIL: "selftest@example.com",
    GIT_COMMITTER_NAME: "selftest", GIT_COMMITTER_EMAIL: "selftest@example.com",
  };
  const git = async (...args: string[]) =>
    (await run("git", ["-c", "commit.gpgsign=false", ...args], { cwd: fixtureRepo, env: gitEnv })).stdout.trim();
  await git("init", "-q", "-b", "main");
  await fs.writeFile(path.join(fixtureRepo, "src/components/Button.tsx"), "export const Button = () => <button>Save</button>;\n");
  await fs.writeFile(path.join(fixtureRepo, "src/styles.css"), ".button { color: red; }\n");
  await fs.writeFile(path.join(fixtureRepo, "server.ts"), "export const port = 3000;\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
  const baseSha = await git("rev-parse", "HEAD");
  const headWith = async (file: string, content: string) => {
    await git("checkout", "-q", baseSha);
    await fs.writeFile(path.join(fixtureRepo, file), content);
    await git("commit", "-q", "-am", `change ${file}`);
    return git("rev-parse", "HEAD");
  };
  const cssHead = await headWith("src/styles.css", ".button { color: blue; }\n");
  const tsxHead = await headWith("src/components/Button.tsx", "export const Button = () => <button>Save changes</button>;\n");
  const backendHead = await headWith("server.ts", "export const port = 4000;\n");
  const runActionOn = async (headSha: string, env: NodeJS.ProcessEnv) => {
    const fixtureEvent = path.join(temporary, "fixture-event.json");
    await fs.writeFile(fixtureEvent, JSON.stringify({
      action: "synchronize", repository: { name: "ignored", owner: { login: "ignored" } },
      pull_request: { number: 7, state: "open", draft: false, title: "Change", user: { login: "ignored" }, base: { sha: baseSha }, head: { sha: headSha } },
    }));
    return run(process.execPath, ["--import", "tsx", "src/index.ts", "--repo", fixtureRepo, "--event", fixtureEvent, "--api-url", apiUrl], { cwd: actionRoot, env });
  };
  for (const reason of ["closed", "draft", "stale_head"]) {
    startResponse = { skipped: true, reason };
    const beforeCalls = calls.length;
    const { stdout } = await runAction();
    assert.match(stdout, new RegExp(`Feature-Rec skipped: ${reason}`));
    assert.equal(calls.length, beforeCalls + 1, "Stale starts exit before classification, rendering, or result callbacks");
  }
  startResponse = { cycleId: "cycle-a", cycleKey: "tenant-a/1#7:abc1234", duplicate: true };
  const beforeDuplicate = calls.length;
  assert.match((await runAction()).stdout, /duplicate start/);
  assert.equal(calls.length, beforeDuplicate + 1);

  startResponse = { cycleId: "cycle-a", cycleKey: "tenant-a/1#7:abc1234", attemptId: "attempt-a" };
  backendStatus = 401;
  await assert.rejects(runAction(), (error: unknown) => {
    const failure = error as Error & { stderr: string };
    assert.match(failure.stderr, /could not report the failure.*backend/);
    const lastError = failure.stderr.slice(failure.stderr.lastIndexOf("Error:"));
    assert.match(lastError, /accepted failed: 401/);
    assert.doesNotMatch(lastError, /\/failed failed/);
    return true;
  });
  backendStatus = 200;

  // Stylesheet-only PR: frontend-visible by the heuristic, but nothing the
  // renderer can reproduce. Accepted with a note instead of failing, so the
  // merge is not blocked.
  calls.length = 0;
  await runActionOn(cssHead, { ...childEnv, FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER: "1" });
  assert.deepEqual(calls.map(call => call.path), ["/api/runs/start", "/api/runs/cycle-a/accepted"]);
  const stylesheetAccept = JSON.parse(calls[1].body) as { frontendVisible: boolean; reason: string; attemptId: string };
  assert.equal(stylesheetAccept.frontendVisible, true);
  assert.match(stylesheetAccept.reason, /Changed files include frontend\/UI candidates/);
  assert.match(stylesheetAccept.reason, /no renderable TSX\/JSX source/);
  assert.equal(stylesheetAccept.attemptId, "attempt-a");

  // Broken key (401) and a TSX change: rendering needs the same key, so the
  // run fails before rendering, with the provider cause and the key hint.
  const brokenKeyEnv = { ...childEnv, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: apiUrl };
  calls.length = 0;
  await assert.rejects(runActionOn(tsxHead, brokenKeyEnv), (error: unknown) => {
    const failure = error as Error & { stderr: string };
    assert.match(failure.stderr, /Anthropic API error 401 \(authentication_error\): invalid x-api-key/);
    return true;
  });
  assert.deepEqual(calls.map(call => call.path), ["/api/runs/start", "/api/runs/cycle-a/failed"]);
  const tsxFailure = JSON.parse(calls[1].body) as { message: string };
  assert.match(tsxFailure.message, /Anthropic API error 401 \(authentication_error\): invalid x-api-key/);
  assert.match(tsxFailure.message, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(tsxFailure.message, /Cannot render|Agent response/);

  // Broken key and a backend-only change: the heuristic accepts the PR, and
  // the check summary names the provider failure.
  calls.length = 0;
  await runActionOn(backendHead, brokenKeyEnv);
  assert.deepEqual(calls.map(call => call.path), ["/api/runs/start", "/api/runs/cycle-a/accepted"]);
  const backendAccept = JSON.parse(calls[1].body) as { frontendVisible: boolean; reason: string; providerError?: string };
  assert.equal(backendAccept.frontendVisible, false);
  assert.match(backendAccept.reason, /Anthropic API error 401 \(authentication_error\): invalid x-api-key/);
  assert.equal(backendAccept.providerError, undefined, "The fallback marker stays in the runner");

  // Broken key and a stylesheet-only change: nothing to render even with a
  // working key, so it is accepted with the note and the provider cause.
  calls.length = 0;
  await runActionOn(cssHead, brokenKeyEnv);
  assert.deepEqual(calls.map(call => call.path), ["/api/runs/start", "/api/runs/cycle-a/accepted"]);
  const stylesheetUnderFailure = JSON.parse(calls[1].body) as { frontendVisible: boolean; reason: string };
  assert.equal(stylesheetUnderFailure.frontendVisible, true);
  assert.match(stylesheetUnderFailure.reason, /no renderable TSX\/JSX source/);
  assert.match(stylesheetUnderFailure.reason, /Anthropic API error 401/);
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log("action backend OIDC selftest passed");
