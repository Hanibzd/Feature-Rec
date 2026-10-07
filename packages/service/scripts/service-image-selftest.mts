import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

// Run separately after building the image; normal selftests never build Docker.
// Only the explicit local test database URL is used, never DATABASE_URL or .env.
const image = process.argv[2] ?? "feature-rec-service:ci";
const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname), "Image selftest requires a local PostgreSQL server");
const suffix = crypto.randomBytes(6).toString("hex");
const dbName = `feature_rec_image_test_${suffix}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
const dockerUrl = new URL(testUrl);
dockerUrl.hostname = process.env.SERVICE_IMAGE_DATABASE_HOST ?? (process.platform === "linux" ? "127.0.0.1" : "host.docker.internal");
const network = process.platform === "linux" ? ["--network", "host"] : [];
const port = String(30_000 + crypto.randomInt(20_000));
const clientSecret = "fixture-image-client-secret";
const encryptionKey = Buffer.alloc(32, 53).toString("base64");
const baseUrl = "https://feature-rec-image.example";
const commonEnv = [
  `DATABASE_URL=${dockerUrl}`, `PORT=${port}`, `FEATURE_REC_BASE_URL=${baseUrl}`,
  `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY=${encryptionKey}`,
];
const oauthEnv = ["SLACK_APP_ID=AIMAGE123", "SLACK_CLIENT_ID=123456.789012", `SLACK_CLIENT_SECRET=${clientSecret}`];
const execute = promisify(execFile);
const containers = new Set<string>();
const secrets = new Set([
  clientSecret, encryptionKey, dockerUrl.toString(), adminUrl.password, decodeURIComponent(adminUrl.password),
].filter(Boolean));
let sequence = 0;
async function docker(args: string[]) {
  return execute("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
}
function environment(extra: string[] = []) {
  return [...commonEnv, ...extra].flatMap((value) => ["--env", value]);
}
async function start(extra: string[] = []): Promise<string> {
  const name = `feature-rec-image-${suffix}-${++sequence}`;
  containers.add(name);
  await docker(["run", "--detach", "--name", name, ...network, ...environment(extra), image]);
  return name;
}
async function stop(name: string): Promise<void> {
  await docker(["stop", "--time", "10", name]);
}
async function admin(args: string[]) {
  return docker(["run", "--rm", ...network, ...environment(), "--entrypoint", "node", image,
    "dist/admin.js", ...args, "--environment", "image-selftest"]);
}
async function request(name: string, path: string) {
  const script = `const r = await fetch(${JSON.stringify(`http://127.0.0.1:${port}${path}`)}, {redirect: "manual"}); console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),cookies:r.headers.getSetCookie(),body:await r.text()}));`;
  const result = await docker(["exec", name, "node", "--input-type=module", "-e", script]);
  return JSON.parse(result.stdout) as { status: number; headers: Record<string, string>; cookies: string[]; body: string };
}
async function healthy(name: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { assert.equal((await request(name, "/health")).status, 200); return; } catch { /* May still be starting. */ }
    const running = (await docker(["inspect", "--format", "{{.State.Running}}", name])).stdout.trim();
    assert.equal(running, "true", "Service exited before health became available");
    await delay(500);
  }
  throw new Error("Service health did not become available");
}
async function exited(name: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await docker(["inspect", "--format", "{{json .State}}", name]);
    const state = JSON.parse(result.stdout) as { Running: boolean; ExitCode: number };
    if (!state.Running) { assert.notEqual(state.ExitCode, 0); return; }
    await delay(500);
  }
  throw new Error("Invalid configuration unexpectedly kept running");
}
function sanitized(text: string): void {
  for (const value of secrets) assert.ok(!text.includes(value), "Image output contained a secret fixture");
}

const control = new Client({ connectionString: adminUrl.toString() });
const db = new Client({ connectionString: testUrl.toString() });
let created = false;
try {
  await control.connect();
  await control.query(`CREATE DATABASE ${dbName}`);
  created = true;
  await db.connect();
  const help = (await docker(["run", "--rm", "--entrypoint", "node", image, "dist/admin.js", "--help"])).stdout;
  assert.match(help, /--slack-installation-id/);
  assert.match(help, /slack-installation-status/);
  assert.match(help, /cancel-slack-installation/);
  assert.match(help, /disable-tenant/);
  assert.match(help, /validate-integrity/);
  assert.match(help, /--check-repository/);

  const disabled = await start();
  await healthy(disabled);
  assert.equal((await request(disabled, "/api/slack/oauth/start")).status, 404);
  await stop(disabled);

  const configured = await start(oauthEnv);
  await healthy(configured);
  const redirect = await request(configured, "/api/slack/oauth/start");
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.location);
  assert.equal(location.origin, "https://slack.com");
  assert.equal(location.searchParams.get("redirect_uri"), `${baseUrl}/api/slack/oauth/callback`);
  assert.equal(redirect.headers["cache-control"], "no-store");
  assert.equal(redirect.headers["referrer-policy"], "no-referrer");
  assert.equal(redirect.cookies.length, 2);
  for (const cookie of redirect.cookies) {
    assert.match(cookie, /; Secure(?:;|$)/);
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Lax(?:;|$)/);
    secrets.add(cookie.split(";")[0].split("=")[1]);
  }
  const queryMarker = "fixture-image-callback-code";
  secrets.add(queryMarker);
  const invalid = await request(configured, `/api/slack/oauth/callback?code=${queryMarker}&state=invalid`);
  assert.equal(invalid.status, 400);
  sanitized(invalid.body);
  assert.equal(invalid.cookies.length, 2);
  await stop(configured);

  const partial = await start([`SLACK_CLIENT_SECRET=${clientSecret}`]);
  await exited(partial);
  const partialLogs = await docker(["logs", partial]);
  sanitized(partialLogs.stdout + partialLogs.stderr);
  assert.ok(!(partialLogs.stdout + partialLogs.stderr).includes("Server listening at"));

  assert.equal((await db.query<{ name: string }>("select name from kysely_migration order by name desc limit 1")).rows[0].name, "0011_multitenant_contract");

  // Staged after the last start: this raw fixture has no key verifier, so startup
  // would refuse it until cancellation clears its ciphertext.
  const pendingId = crypto.randomUUID();
  const pendingCiphertext = "fixture-image-pending-ciphertext";
  secrets.add(pendingCiphertext);
  await db.query(`insert into slack_oauth_installations
    (id, status, claimed_at, team_id, bot_user_id, bot_token_ciphertext)
    values ($1, 'pending', clock_timestamp(), 'TIMAGE', 'UIMAGE', $2)`, [pendingId, pendingCiphertext]);
  const status = (await admin(["slack-installation-status", "--slack-installation-id", pendingId])).stdout;
  sanitized(status);
  assert.equal((JSON.parse(status) as { installation: { status: string } }).installation.status, "pending");
  // Cancel the staged installation and the OAuth session left by the redirect check.
  for (const row of (await db.query<{ id: string }>("select id from slack_oauth_installations where status in ('awaiting_callback', 'exchanging', 'pending')")).rows) {
    const cancelled = (await admin(["cancel-slack-installation", "--slack-installation-id", row.id, "--confirm"])).stdout;
    sanitized(cancelled);
    assert.equal((JSON.parse(cancelled) as { cancelled: boolean }).cancelled, true);
  }
  assert.equal((await db.query<{ count: string }>("select count(*) from slack_oauth_installations where state_hash is not null or browser_binding_hash is not null or bot_token_ciphertext is not null")).rows[0].count, "0");

  const tenantId = crypto.randomUUID();
  await db.query("insert into tenants (id, enabled) values ($1, true)", [tenantId]);
  const disabledTenant = JSON.parse((await admin(["disable-tenant", "--tenant-id", tenantId, "--confirm"])).stdout) as unknown;
  assert.deepEqual(disabledTenant, { environment: "image-selftest", tenantId, enabled: false });
  assert.equal((await db.query<{ enabled: boolean }>("select enabled from tenants where id = $1", [tenantId])).rows[0].enabled, false);
  await assert.rejects(admin(["disable-tenant", "--tenant-id", tenantId, "--confirm"]), /is already disabled/);
  const final = await start(oauthEnv);
  await healthy(final);
  await stop(final);
  for (const name of containers) {
    const logs = await docker(["logs", name]);
    sanitized(logs.stdout + logs.stderr);
  }
  console.log("Service image selftest passed: configured/disabled health, redirect/cookies, partial configuration, compiled admin status, cancellation and tenant disabling.");
} catch (error) {
  // Capture evidence before cleanup, without leaking fixtures or masking the test failure.
  for (const name of containers) {
    try {
      const logs = await docker(["logs", name]);
      let output = logs.stdout + logs.stderr;
      for (const value of [...secrets].sort((left, right) => right.length - left.length)) {
        output = output.replaceAll(value, "[REDACTED]");
      }
      console.error(`Service image failure logs (${name}):\n${output}`);
    } catch {
      console.error(`Service image failure logs unavailable (${name})`);
    }
  }
  throw error;
} finally {
  for (const name of containers) await docker(["rm", "--force", name]).catch(() => {});
  await db.end();
  if (created) await control.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await control.end();
}
