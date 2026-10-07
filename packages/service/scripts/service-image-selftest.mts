import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

// Smoke test for the packaged service. Run separately after building the image;
// normal selftests never build Docker. Only the explicit local test database URL
// is used, never DATABASE_URL or .env, and every value below is a fixture.
const image = process.argv[2] ?? "feature-rec-service:ci";
const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname), "Image selftest requires a local PostgreSQL server");
const suffix = crypto.randomBytes(6).toString("hex");
const dbName = `feature_rec_image_test_${suffix}`;
const dockerUrl = new URL(adminUrl);
dockerUrl.pathname = `/${dbName}`;
dockerUrl.hostname = process.env.SERVICE_IMAGE_DATABASE_HOST ?? (process.platform === "linux" ? "127.0.0.1" : "host.docker.internal");
const network = process.platform === "linux" ? ["--network", "host"] : [];
// Stay below the ephemeral ranges (Linux 32768+, macOS 49152+): with host
// networking, an outbound connection can already hold a port in those ranges.
const port = String(10_000 + crypto.randomInt(20_000));
const commonEnv = [
  `DATABASE_URL=${dockerUrl}`, `PORT=${port}`, "FEATURE_REC_BASE_URL=https://feature-rec-image.example",
  `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY=${Buffer.alloc(32, 53).toString("base64")}`,
];
const oauthEnv = ["SLACK_APP_ID=AIMAGE123", "SLACK_CLIENT_ID=123456.789012", "SLACK_CLIENT_SECRET=fixture-image-client-secret"];
const execute = promisify(execFile);
const containers = new Set<string>();
let sequence = 0;
async function docker(args: string[]) {
  return execute("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
}
async function start(extra: string[] = []): Promise<string> {
  const name = `feature-rec-image-${suffix}-${++sequence}`;
  containers.add(name);
  const environment = [...commonEnv, ...extra].flatMap((value) => ["--env", value]);
  await docker(["run", "--detach", "--name", name, ...network, ...environment, image]);
  return name;
}
async function healthy(name: string): Promise<void> {
  const script = `const r = await fetch(${JSON.stringify(`http://127.0.0.1:${port}/health`)}); process.exitCode = r.status === 200 ? 0 : 1;`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await docker(["exec", name, "node", "--input-type=module", "-e", script]); return; } catch { /* May still be starting. */ }
    const running = (await docker(["inspect", "--format", "{{.State.Running}}", name])).stdout.trim();
    assert.equal(running, "true", "Service exited before health became available");
    await delay(500);
  }
  throw new Error("Service health did not become available");
}

const control = new Client({ connectionString: adminUrl.toString() });
let created = false;
try {
  await control.connect();
  await control.query(`CREATE DATABASE ${dbName}`);
  created = true;
  const help = (await docker(["run", "--rm", "--entrypoint", "node", image, "dist/admin.js", "--help"])).stdout;
  assert.match(help, /^Feature-Rec production administration/);

  for (const extra of [[], oauthEnv]) {
    const name = await start(extra);
    await healthy(name);
    await docker(["stop", "--time", "10", name]);
  }

  // The packaged admin bundle must reach PostgreSQL with only DATABASE_URL.
  const status = JSON.parse((await docker(["run", "--rm", ...network, "--env", `DATABASE_URL=${dockerUrl}`,
    "--entrypoint", "node", image, "dist/admin.js", "migration-status", "--environment", "image-selftest"])).stdout) as { migrations: Array<{ status: string }> };
  assert.ok(status.migrations.length > 0);
  assert.ok(status.migrations.every((migration) => migration.status === "executed"));
  console.log("Service image selftest passed: admin help, health with and without hosted OAuth, and admin migration status.");
} catch (error) {
  // Capture evidence before cleanup without masking the test failure.
  for (const name of containers) {
    const logs = await docker(["logs", name]).catch(() => null);
    console.error(logs ? `Service image logs (${name}):\n${logs.stdout}${logs.stderr}` : `Service image logs unavailable (${name})`);
  }
  throw error;
} finally {
  for (const name of containers) await docker(["rm", "--force", name]).catch(() => {});
  if (created) await control.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await control.end();
}
