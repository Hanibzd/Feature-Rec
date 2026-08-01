import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import { Client, Pool } from "pg";
import {
  buildCycleKey,
  SLACK_GREETING_ACTIVE,
  SLACK_MULTIPLE_CHANNELS_MESSAGE,
  SLACK_NO_CHANNEL_MESSAGE,
  slackSelectedChannelUnavailableMessage,
  type RunStartRequest,
} from "@feature-rec/core";
import { ChannelResolutionError, resolveChannel } from "../src/channels";
import { GitHubClient } from "../src/github";
import type { ServiceEnv } from "../src/env";
import { buildServer } from "../src/http";
import { SlackClient, verifySlackSignature } from "../src/slack";
import { PostgresCycleStore } from "../src/storage/postgres";
import { migrationProvider } from "../src/storage/migrations";
import type { DB } from "../src/storage/schema";

// Requires a Postgres reachable at TEST_DATABASE_URL (an admin/maintenance DB).
// The suite creates a uniquely named database, runs against it, then drops it,
// so parallel CI runs can't collide. Local one-liner:
//   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:18
const adminUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

// CREATE/DROP DATABASE can't take bound params, so the name comes from a
// safe-identifier alphabet only (lowercase hex + underscores).
const dbName = `feature_rec_test_${crypto.randomBytes(8).toString("hex")}`;

const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();

const testUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
})();

const env: ServiceEnv = {
  port: 0,
  baseUrl: "http://localhost",
  databaseUrl: testUrl,
  runnerToken: "runner-secret",
  githubToken: "",
  githubAppId: "",
  githubPrivateKey: "",
  slackBotToken: "",
  slackSigningSecret: "slack-secret",
};

const RUNNER_AUTH = `Bearer ${env.runnerToken}`;

type StartResponse = {
  cycleId?: string;
  cycleKey?: string;
  checkRunId?: number;
  duplicate?: boolean;
  attemptId?: string;
  onboarded?: boolean;
};

type ResultResponse = {
  ok?: boolean;
  stale?: boolean;
  error?: string;
  message?: string;
  settled?: boolean;
};

type AppInstance = ReturnType<typeof buildServer>;

const apps: AppInstance[] = [];

function makeApp(github: unknown, slack: unknown): AppInstance {
  const app = buildServer({ env, store, github: github as never, slack: slack as never });
  apps.push(app);
  return app;
}

function makeGithubStub() {
  const checkRuns = new Map<
    number,
    { status?: string; conclusion?: string; summary?: string }
  >();
  let nextId = 1000;
  const stub = {
    createCheckRunCalls: 0,
    acceptCalls: 0,
    rejectCalls: 0,
    checkRuns,
    createCheckRun: async (): Promise<number> => {
      stub.createCheckRunCalls += 1;
      const id = nextId;
      nextId += 1;
      checkRuns.set(id, { status: "in_progress" });
      return id;
    },
    updateCheckRun: async (
      cycle: { checkRunId?: number | null },
      input: { status?: string; conclusion?: string; output?: { summary?: string } },
    ): Promise<void> => {
      if (!cycle.checkRunId) return;
      checkRuns.set(cycle.checkRunId, {
        status: input.status,
        conclusion: input.conclusion,
        summary: input.output?.summary,
      });
    },
    accept: async (): Promise<void> => {
      stub.acceptCalls += 1;
    },
    reject: async (): Promise<void> => {
      stub.rejectCalls += 1;
    },
  };
  return stub;
}

function makeSlackStub(options: { teamId?: string; channels?: string[] } = {}) {
  const teamId = options.teamId ?? "T0123";
  const finalizeCalls: Array<{ state: string; channel: string; ts: string }> = [];
  const stub = {
    channels: options.channels ?? ["C0123"],
    usergroups: [] as Array<{ id: string; handle: string }>,
    usergroupMembers: {} as Record<string, string[]>,
    channelMembers: {} as Record<string, string[]>,
    postMessageCalls: [] as Array<{ channel: string; text: string }>,
    ephemeralCalls: [] as Array<{ url: string; text: string }>,
    uploadVideoChannels: [] as string[],
    postValidationArgs: [] as Array<{ channel: string; mention: string | null }>,
    uploadVideoCalls: 0,
    postValidationCalls: 0,
    isApproverCalls: 0,
    finalizeCalls,
    botIdentity: async () => ({ userId: "UBOT", teamId }),
    listBotChannels: async (): Promise<string[]> => [...stub.channels],
    listUsergroups: async (): Promise<Array<{ id: string; handle: string }>> =>
      stub.usergroups,
    listChannelMembers: async (channelId: string): Promise<string[]> => [
      ...(stub.channelMembers[channelId] ?? []),
    ],
    listUsergroupMembers: async (usergroupId: string): Promise<string[]> => [
      ...(stub.usergroupMembers[usergroupId] ?? []),
    ],
    postMessage: async (channel: string, text: string): Promise<void> => {
      stub.postMessageCalls.push({ channel, text });
    },
    respondEphemeral: async (url: string, text: string): Promise<void> => {
      stub.ephemeralCalls.push({ url, text });
    },
    uploadVideo: async (_cycle: unknown, channel: string): Promise<void> => {
      stub.uploadVideoCalls += 1;
      stub.uploadVideoChannels.push(channel);
    },
    postValidation: async (
      _cycle: unknown,
      channel: string,
      mention: string | null,
    ): Promise<{ channel: string; ts: string }> => {
      stub.postValidationCalls += 1;
      stub.postValidationArgs.push({ channel, mention });
      return { channel, ts: `1710000000.${String(stub.postValidationCalls).padStart(6, "0")}` };
    },
    finalize: async (
      cycle: { slackChannelId: string | null; slackMessageTs: string | null },
      state: string,
    ): Promise<void> => {
      // Mirror the real client: it no-ops when the message coordinates are absent.
      if (!cycle.slackChannelId || !cycle.slackMessageTs) return;
      finalizeCalls.push({ state, channel: cycle.slackChannelId, ts: cycle.slackMessageTs });
    },
    openRequestChangesModal: async (): Promise<void> => {},
    // Same semantics as SlackClient.isApprover, with usergroup expansion
    // served from usergroupMembers instead of the Slack API.
    isApprover: async (
      approvers: string[] | null,
      userId: string | undefined,
    ): Promise<boolean> => {
      stub.isApproverCalls += 1;
      if (!approvers || approvers.length === 0) return true;
      if (!userId) return false;
      if (approvers.includes(userId)) return true;
      return approvers.some((id) => (stub.usergroupMembers[id] ?? []).includes(userId));
    },
  };
  return stub;
}

function makeStart(prNumber: number, overrides: Partial<RunStartRequest> = {}): RunStartRequest {
  return {
    owner: "MathFreedom",
    repo: "Agora",
    prNumber,
    prTitle: "Add button",
    prAuthor: "romain",
    headSha: "abc1234567",
    baseSha: "def1234567",
    ...overrides,
  };
}

async function startRun(app: AppInstance, start: RunStartRequest) {
  const res = await app.inject({
    method: "POST",
    url: "/api/runs/start",
    headers: { authorization: RUNNER_AUTH, "content-type": "application/json" },
    payload: JSON.stringify(start),
  });
  return { res, body: JSON.parse(res.body) as StartResponse };
}

async function postResult(
  app: AppInstance,
  cycleId: string,
  action: "accepted" | "failed",
  payload: unknown,
) {
  const res = await app.inject({
    method: "POST",
    url: `/api/runs/${cycleId}/${action}`,
    headers: { authorization: RUNNER_AUTH, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
  return { res, body: JSON.parse(res.body) as ResultResponse };
}

async function postVideo(app: AppInstance, cycleId: string, attemptId?: string) {
  const headers: Record<string, string> = {
    authorization: RUNNER_AUTH,
    "content-type": "application/octet-stream",
  };
  if (attemptId) headers["x-feature-rec-attempt"] = attemptId;
  const res = await app.inject({
    method: "POST",
    url: `/api/runs/${cycleId}/video`,
    headers,
    payload: Buffer.alloc(1024),
  });
  return { res, body: JSON.parse(res.body) as ResultResponse & { channel?: string; ts?: string } };
}

function signSlack(rawBody: string, timestamp: string): string {
  return `v0=${crypto
    .createHmac("sha256", env.slackSigningSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

// Interaction dedupe is global (processed_interactions): every test must use
// a unique triggerId/actionTs (and viewId) or it silently dedupes as stale.
async function postBlockAction(
  app: AppInstance,
  input: {
    cycleId: string;
    headSha: string;
    action: "accept" | "request_changes";
    actionTs: string;
    triggerId: string;
    userId?: string;
    teamId?: string;
    responseUrl?: string;
  },
) {
  const payload = {
    type: "block_actions",
    trigger_id: input.triggerId,
    ...(input.teamId ? { team: { id: input.teamId } } : {}),
    ...(input.responseUrl ? { response_url: input.responseUrl } : {}),
    user: { id: input.userId ?? "U999" },
    actions: [
      {
        action_id: input.action === "accept" ? "feature_rec_accept" : "feature_rec_request_changes",
        action_ts: input.actionTs,
        value: JSON.stringify({ action: input.action, cycleId: input.cycleId, headSha: input.headSha }),
      },
    ],
  };
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/api/slack/interactivity",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlack(rawBody, timestamp),
    },
    payload: rawBody,
  });
}

async function postViewSubmission(
  app: AppInstance,
  input: {
    cycleId: string;
    headSha: string;
    viewId: string;
    comment: string;
    userId?: string;
    teamId?: string;
    responseUrl?: string;
  },
) {
  const payload = {
    type: "view_submission",
    ...(input.teamId ? { team: { id: input.teamId } } : {}),
    user: { id: input.userId ?? "U999" },
    view: {
      id: input.viewId,
      hash: `${input.viewId}-hash`,
      private_metadata: JSON.stringify({
        cycleId: input.cycleId,
        headSha: input.headSha,
        responseUrl: input.responseUrl,
      }),
      state: { values: { comment: { value: { value: input.comment } } } },
    },
  };
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/api/slack/interactivity",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlack(rawBody, timestamp),
    },
    payload: rawBody,
  });
}

async function postSlackEvent(app: AppInstance, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/api/slack/events",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlack(rawBody, timestamp),
    },
    payload: rawBody,
  });
}

function membershipEvent(input: {
  type: "member_joined_channel" | "member_left_channel";
  teamId: string;
  user: string;
  channel: string;
  ts: string;
}) {
  return {
    type: "event_callback",
    team_id: input.teamId,
    event: { type: input.type, user: input.user, channel: input.channel, event_ts: input.ts },
  };
}

async function postCommand(
  app: AppInstance,
  input: {
    teamId: string;
    channelId: string;
    userId: string;
    text: string;
    responseUrl: string;
  },
) {
  const rawBody = new URLSearchParams({
    command: "/feature-rec",
    team_id: input.teamId,
    channel_id: input.channelId,
    user_id: input.userId,
    text: input.text,
    response_url: input.responseUrl,
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/api/slack/commands",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlack(rawBody, timestamp),
    },
    payload: rawBody,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return false;
}

const store = new PostgresCycleStore(testUrl);
await store.init();

try {
  // --- Migration 0005 backfills the effective active route and preserves settings ---
  {
    const migrationDbName = `${dbName}_migration`;
    const migrationAdmin = new Client({ connectionString: adminUrl });
    await migrationAdmin.connect();
    await migrationAdmin.query(`CREATE DATABASE ${migrationDbName}`);
    await migrationAdmin.end();
    const migrationUrl = (() => {
      const url = new URL(adminUrl);
      url.pathname = `/${migrationDbName}`;
      return url.toString();
    })();
    const migrationDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: migrationUrl }) }),
    });
    try {
      const migrator = new Migrator({ db: migrationDb, provider: migrationProvider });
      const beforeRoute = await migrator.migrateTo("0004_last_left_at");
      if (beforeRoute.error) throw beforeRoute.error;
      const seed = new Client({ connectionString: migrationUrl });
      await seed.connect();
      await seed.query(`
        insert into bot_channels
          (team_id, channel_id, joined_at, first_seen_at, last_seen_at, left_at)
        values
          ('TBACKFILL', 'CNEWER', '2026-01-02', '2026-01-02', '2026-01-02', null),
          ('TBACKFILL', 'COLDEST', '2026-01-01', '2026-01-01', '2026-01-01', null),
          ('TBACKFILL', 'CLEFT',   '2025-12-01', '2025-12-01', '2025-12-01', '2026-01-03'),
          ('TLEFTONLY', 'CGONE',  '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-02')
      `);
      await seed.query(`
        insert into channel_settings
          (team_id, channel_id, mention, approvers, updated_by, updated_at)
        values
          ('TBACKFILL', 'COLDEST', '<!here>', '["U1"]', 'U1', now()),
          ('TBACKFILL', 'CNEWER',  '', null, 'U2', now())
      `);
      await seed.end();

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const routes = await migrationDb.selectFrom("team_channel_routes").selectAll().execute();
      assert.deepEqual(routes, [
        { team_id: "TBACKFILL", selected_channel_id: "COLDEST" },
      ]);
      assert.equal(
        await migrationDb
          .selectFrom("channel_settings")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
          .then((row) => row.count),
        "2",
      );
    } finally {
      await migrationDb.destroy();
      const dropMigration = new Client({ connectionString: adminUrl });
      await dropMigration.connect();
      await dropMigration.query(`DROP DATABASE IF EXISTS ${migrationDbName} WITH (FORCE)`);
      await dropMigration.end();
    }
  }

  // --- Store basics: startCycle create + duplicate, dedupe, lookups ---
  {
    const start = makeStart(13, { headSha: "basics0001" });
    const cycleKey = buildCycleKey(start);
    const first = await store.startCycle({ ...start, cycleKey });
    const second = await store.startCycle({ ...start, cycleKey });

    assert.equal(first.created, true);
    assert.ok(first.attemptId);
    assert.equal(second.created, false);
    assert.equal(second.attemptId, null);
    assert.equal(first.cycle.id, second.cycle.id);

    assert.equal(await store.recordProcessedInteraction("i1", first.cycle.id), true);
    assert.equal(await store.recordProcessedInteraction("i1", first.cycle.id), false);

    assert.equal((await store.getCycleByKey(cycleKey))?.id, first.cycle.id);
    assert.equal(await store.getCycleByKey("does-not-exist"), null);
  }

  // --- GitHubClient template rendering via a stubbed fetch ---
  {
    const start = makeStart(1, { headSha: "github0001" });
    const created = await store.startCycle({ ...start, cycleKey: buildCycleKey(start) });
    await store.attachCheckRun(created.cycle.id, 123);
    const cycleForGithub = await store.getCycle(created.cycle.id);
    assert.ok(cycleForGithub);

    const previousFetch = globalThis.fetch;
    const githubCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);
      const reqBody = init?.body ? JSON.parse(String(init.body)) : {};
      githubCalls.push({ url: urlText, body: reqBody });
      const json = urlText.includes("/issues/")
        ? { html_url: "https://github.com/MathFreedom/Agora/pull/1#issuecomment-9" }
        : { id: 123 };
      return new Response(JSON.stringify(json), {
        status: urlText.includes("/issues/") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const client = new GitHubClient({ ...env, githubToken: "gh-token" });
      await client.reject(cycleForGithub, "make it feel premium");
      await client.accept(cycleForGithub);
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(githubCalls[0].url.endsWith("/repos/MathFreedom/Agora/issues/1/comments"), true);
    assert.equal(
      githubCalls[0].body.body,
      "@romain make the following changes:\n\nmake it feel premium",
    );
    assert.equal(githubCalls[1].url.endsWith("/repos/MathFreedom/Agora/check-runs/123"), true);
    assert.equal(
      (githubCalls[1].body.output as { summary: string }).summary.includes("issuecomment-9"),
      true,
    );
    assert.equal(
      (githubCalls[1].body.output as { summary: string }).summary.includes("make it feel premium"),
      false,
    );
    assert.equal(githubCalls[2].url.endsWith("/repos/MathFreedom/Agora/issues/1/comments"), true);
    assert.equal(githubCalls[2].body.body, "@romain validation passed; you can merge.");
    assert.equal(githubCalls[3].url.endsWith("/repos/MathFreedom/Agora/check-runs/123"), true);
    assert.equal(
      (githubCalls[3].body.output as { summary: string }).summary.includes("issuecomment-9"),
      true,
    );
  }

  // --- verifySlackSignature rejects bad input ---
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    assert.equal(
      verifySlackSignature({ signingSecret: "", timestamp, signature: "v0=short", rawBody: "" }),
      false,
    );
    assert.equal(
      verifySlackSignature({
        signingSecret: env.slackSigningSecret,
        timestamp,
        signature: "v0=short",
        rawBody: "",
      }),
      false,
    );
  }

  // --- HTTP auth: start without a runner token is unauthorized ---
  {
    const app = makeApp(makeGithubStub(), makeSlackStub());
    const res = await app.inject({
      method: "POST",
      url: "/api/runs/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(makeStart(14, { headSha: "unauth0001" })),
    });
    assert.equal(res.statusCode, 401);
  }

  // --- HTTP: invalid Slack signature is rejected ---
  {
    const app = makeApp(makeGithubStub(), makeSlackStub());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await app.inject({
      method: "POST",
      url: "/api/slack/interactivity",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=short",
      },
      payload: "payload={}",
    });
    assert.equal(res.statusCode, 401);
  }

  // --- Store-level concurrency: two heads, one active cycle ---
  {
    const a = makeStart(2, { headSha: "store00001a" });
    const b = makeStart(2, { headSha: "store00002b" });
    const [ra, rb] = await Promise.all([
      store.startCycle({ ...a, cycleKey: buildCycleKey(a) }),
      store.startCycle({ ...b, cycleKey: buildCycleKey(b) }),
    ]);
    const finalA = await store.getCycle(ra.cycle.id);
    const finalB = await store.getCycle(rb.cycle.id);
    const analyzing = [finalA, finalB].filter((c) => c?.status === "analyzing");
    const superseded = [finalA, finalB].filter((c) => c?.status === "superseded");
    assert.equal(analyzing.length, 1);
    assert.equal(superseded.length, 1);
  }

  // --- (a) newer-head supersession over HTTP; loser's check run neutralized ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const a = makeStart(3, { headSha: "httpsup001a" });
    const b = makeStart(3, { headSha: "httpsup002b" });
    const [ra, rb] = await Promise.all([startRun(app, a), startRun(app, b)]);
    assert.ok(ra.body.cycleId);
    assert.ok(rb.body.cycleId);

    const finalA = await store.getCycle(ra.body.cycleId);
    const finalB = await store.getCycle(rb.body.cycleId);
    const loser = [finalA, finalB].find((c) => c?.status === "superseded");
    const winner = [finalA, finalB].find((c) => c?.status === "analyzing");
    assert.ok(loser);
    assert.ok(winner);
    assert.equal(github.createCheckRunCalls, 2);

    assert.ok(loser.checkRunId);
    assert.ok(
      await waitFor(async () => github.checkRuns.get(loser.checkRunId ?? 0)?.conclusion === "neutral"),
    );
    if (winner.checkRunId) {
      assert.notEqual(github.checkRuns.get(winner.checkRunId)?.conclusion, "neutral");
    }
  }

  // --- Superseded cleanup is best-effort: a failed old check update must not block the new run ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const first = (await startRun(app, makeStart(14, { headSha: "cleanup001a" }))).body;
    assert.ok(first.checkRunId);

    let cleanupAttempts = 0;
    const updateCheckRun = github.updateCheckRun;
    github.updateCheckRun = async (cycle, input): Promise<void> => {
      if (cycle.checkRunId === first.checkRunId) {
        cleanupAttempts += 1;
        throw new Error("cleanup failed");
      }
      await updateCheckRun(cycle, input);
    };

    const second = await startRun(app, makeStart(14, { headSha: "cleanup002b" }));
    assert.equal(second.res.statusCode, 200);
    assert.ok(second.body.checkRunId);
    assert.ok(second.body.attemptId);
    assert.equal(github.createCheckRunCalls, 2);
    assert.equal((await store.getCycle(second.body.cycleId ?? ""))?.checkRunId, second.body.checkRunId);
    assert.ok(await waitFor(async () => cleanupAttempts > 0));
    assert.equal((await store.getCycle(first.cycleId ?? ""))?.status, "superseded");
  }

  // --- (b) same-head duplicate start: one created, one duplicate, one check run ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const start = makeStart(4, { headSha: "httpdup001" });
    const [r1, r2] = await Promise.all([startRun(app, start), startRun(app, start)]);
    const bodies = [r1.body, r2.body];
    const duplicates = bodies.filter((b) => b.duplicate === true);
    const creators = bodies.filter((b) => b.duplicate !== true);
    assert.equal(duplicates.length, 1);
    assert.equal(creators.length, 1);
    assert.ok(creators[0].checkRunId);
    assert.ok(creators[0].attemptId);
    assert.equal(github.createCheckRunCalls, 1);
  }

  // --- Check Run creation failure releases the cycle for a same-head rerun ---
  {
    const github = makeGithubStub();
    const createCheckRun = github.createCheckRun;
    github.createCheckRun = async (): Promise<number> => {
      if (github.createCheckRunCalls === 0) {
        github.createCheckRunCalls += 1;
        throw new Error("GitHub App credentials are missing");
      }
      return createCheckRun();
    };
    const app = makeApp(github, makeSlackStub());
    const start = makeStart(15, { headSha: "retryinit01" });

    const failed = await startRun(app, start);
    assert.equal(failed.res.statusCode, 500);
    assert.equal((await store.getCycleByKey(buildCycleKey(start)))?.status, "failed");

    const rerun = await startRun(app, start);
    assert.equal(rerun.res.statusCode, 200);
    assert.equal(rerun.body.duplicate, undefined);
    assert.ok(rerun.body.attemptId);
    assert.ok(rerun.body.checkRunId);
    assert.equal(github.createCheckRunCalls, 2);
  }

  // --- (c) stale runner no-op: superseded head A can't post results ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    const app = makeApp(github, slack);
    const a = makeStart(5, { headSha: "stale0001a" });
    const b = makeStart(5, { headSha: "stale0002b" });
    const startA = (await startRun(app, a)).body;
    await startRun(app, b);
    assert.ok(startA.cycleId);
    assert.ok(startA.attemptId);
    assert.equal((await store.getCycle(startA.cycleId))?.status, "superseded");

    const accepted = await postResult(app, startA.cycleId, "accepted", { attemptId: startA.attemptId });
    const failed = await postResult(app, startA.cycleId, "failed", { attemptId: startA.attemptId });
    const video = await postVideo(app, startA.cycleId, startA.attemptId);
    assert.equal(accepted.res.statusCode, 200);
    assert.equal(accepted.body.stale, true);
    assert.equal(failed.body.stale, true);
    assert.equal(video.body.stale, true);

    const finalA = await store.getCycle(startA.cycleId);
    assert.equal(finalA?.status, "superseded");
    assert.equal(finalA?.slackMessageTs, null);
    assert.equal(slack.postValidationCalls, 0);
  }

  // --- (d) attempt ownership: wrong token is stale, missing/malformed is 400 ---
  {
    const app = makeApp(makeGithubStub(), makeSlackStub());
    const start = (await startRun(app, makeStart(6, { headSha: "attempt001" }))).body;
    assert.ok(start.cycleId);

    const wrong = await postResult(app, start.cycleId, "accepted", { attemptId: crypto.randomUUID() });
    assert.equal(wrong.res.statusCode, 200);
    assert.equal(wrong.body.stale, true);
    assert.equal((await store.getCycle(start.cycleId))?.status, "analyzing");

    const missing = await postResult(app, start.cycleId, "accepted", {});
    assert.equal(missing.res.statusCode, 400);
    const malformed = await postResult(app, start.cycleId, "accepted", { attemptId: 123 });
    assert.equal(malformed.res.statusCode, 400);
    assert.equal((await store.getCycle(start.cycleId))?.status, "analyzing");
  }

  // --- (e) runner /accepted on a pending_validation cycle is stale ---
  {
    const app = makeApp(makeGithubStub(), makeSlackStub());
    const start = (await startRun(app, makeStart(7, { headSha: "pending001" }))).body;
    assert.ok(start.cycleId);
    assert.ok(start.attemptId);

    const video = await postVideo(app, start.cycleId, start.attemptId);
    assert.equal(video.res.statusCode, 200);
    assert.equal((await store.getCycle(start.cycleId))?.status, "pending_validation");

    const accepted = await postResult(app, start.cycleId, "accepted", { attemptId: start.attemptId });
    assert.equal(accepted.res.statusCode, 200);
    assert.equal(accepted.body.stale, true);
    assert.equal((await store.getCycle(start.cycleId))?.status, "pending_validation");
  }

  // --- (f) stale duplicate start can't displace the active head ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const a = makeStart(8, { headSha: "displace01a" });
    const b = makeStart(8, { headSha: "displace02b" });
    const startA = (await startRun(app, a)).body;
    const startB = (await startRun(app, b)).body;
    assert.ok(startA.cycleId);
    assert.ok(startB.cycleId);
    assert.equal((await store.getCycle(startB.cycleId))?.status, "analyzing");

    const lateDuplicate = (await startRun(app, a)).body;
    assert.equal(lateDuplicate.duplicate, true);
    assert.equal((await store.getCycle(startB.cycleId))?.status, "analyzing");
    assert.equal((await store.getCycle(startA.cycleId))?.status, "superseded");
  }

  // --- (g) double Slack click: only one GitHub accept, loser stops at transition ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const start = (await startRun(app, makeStart(9, { headSha: "dblclick01" }))).body;
    assert.ok(start.cycleId);
    assert.ok(start.attemptId);
    await store.transitionRunnerStatus({
      cycleId: start.cycleId,
      attemptId: start.attemptId,
      from: ["analyzing"],
      to: "pending_validation",
    });

    await Promise.all([
      postBlockAction(app, {
        cycleId: start.cycleId,
        headSha: "dblclick01",
        action: "accept",
        actionTs: "1710000000.000001",
        triggerId: "T1",
      }),
      postBlockAction(app, {
        cycleId: start.cycleId,
        headSha: "dblclick01",
        action: "accept",
        actionTs: "1710000000.000002",
        triggerId: "T2",
      }),
    ]);

    const settled = await waitFor(
      async () => (await store.getCycle(start.cycleId!))?.status === "accepted",
    );
    assert.equal(settled, true);
    await sleep(200);
    assert.equal(github.acceptCalls, 1);
  }

  // --- Slack approver restriction: non-approver click is ignored ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    slack.isApprover = async () => {
      slack.isApproverCalls += 1;
      return false;
    };
    const app = makeApp(github, slack);
    const start = makeStart(10, { headSha: "approver01" });
    const created = await store.startCycle({ ...start, cycleKey: buildCycleKey(start) });
    assert.ok(created.attemptId);
    await store.transitionRunnerStatus({
      cycleId: created.cycle.id,
      attemptId: created.attemptId,
      from: ["analyzing"],
      to: "pending_validation",
    });

    await postBlockAction(app, {
      cycleId: created.cycle.id,
      headSha: "approver01",
      action: "accept",
      actionTs: "1710000000.000003",
      triggerId: "T3",
    });
    const checked = await waitFor(async () => slack.isApproverCalls === 1);
    assert.equal(checked, true);
    await sleep(200);
    assert.equal(github.acceptCalls, 0);
    assert.equal((await store.getCycle(created.cycle.id))?.status, "pending_validation");
  }

  // --- (h) supersession between /video transition and the Slack post ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    const app = makeApp(github, slack);
    const startA = (await startRun(app, makeStart(11, { headSha: "video0001a" }))).body;
    assert.ok(startA.cycleId);
    assert.ok(startA.attemptId);

    // Inject the race deterministically: posting the validation message starts a
    // newer head, which supersedes A before its own attachSlackMessage runs.
    slack.postValidation = async () => {
      slack.postValidationCalls += 1;
      await startRun(app, makeStart(11, { headSha: "video0002b" }));
      return { channel: "C0123", ts: "1710000000.000777" };
    };

    const video = await postVideo(app, startA.cycleId, startA.attemptId);
    assert.equal(video.res.statusCode, 200);

    assert.equal(slack.finalizeCalls.length, 1);
    assert.equal(slack.finalizeCalls[0].state, "superseded");
    assert.equal(slack.finalizeCalls[0].ts, "1710000000.000777");
    const finalA = await store.getCycle(startA.cycleId);
    assert.equal(finalA?.status, "superseded");
    assert.equal(finalA?.slackMessageTs, null);
  }

  // --- (i) takeover from failed: fresh attempt, reused check run, old token stale ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const start = makeStart(12, { headSha: "takeover01" });
    const first = (await startRun(app, start)).body;
    assert.ok(first.cycleId);
    assert.ok(first.attemptId);
    assert.ok(first.checkRunId);
    assert.equal(github.createCheckRunCalls, 1);

    const failed = await postResult(app, first.cycleId, "failed", { attemptId: first.attemptId });
    assert.equal(failed.body.ok, true);
    assert.equal((await store.getCycle(first.cycleId))?.status, "failed");

    const rerun = (await startRun(app, start)).body;
    assert.equal(rerun.duplicate, undefined);
    assert.ok(rerun.attemptId);
    assert.notEqual(rerun.attemptId, first.attemptId);
    assert.equal(rerun.checkRunId, first.checkRunId);
    assert.equal(github.createCheckRunCalls, 1);
    assert.equal((await store.getCycle(first.cycleId))?.status, "analyzing");

    const staleResult = await postResult(app, first.cycleId, "accepted", {
      attemptId: first.attemptId,
    });
    assert.equal(staleResult.res.statusCode, 200);
    assert.equal(staleResult.body.stale, true);
    assert.equal((await store.getCycle(first.cycleId))?.status, "analyzing");
  }

  // --- Explicit channel routing: fallback, selection, no failover, guards ---
  {
    let membershipSweepCompleted = false;
    const serializedStore = {
      getSelectedChannelId: async (): Promise<string | null> => {
        assert.equal(membershipSweepCompleted, true);
        return "CSERIAL";
      },
    };
    const serializedSlack = {
      botIdentity: async () => ({ userId: "UBOT", teamId: "TSERIAL" }),
      listBotChannels: async (): Promise<string[]> => {
        await sleep(10);
        membershipSweepCompleted = true;
        return ["CSERIAL"];
      },
    };
    assert.equal(
      (
        await resolveChannel(
          serializedStore as never,
          serializedSlack as never as SlackClient,
        )
      ).channelId,
      "CSERIAL",
    );

    const slack = makeSlackStub({ teamId: "TROUTE", channels: [] });
    const slackClient = slack as never as SlackClient;

    await assert.rejects(
      resolveChannel(store, slackClient),
      (err: unknown) =>
        err instanceof ChannelResolutionError && err.message === SLACK_NO_CHANNEL_MESSAGE,
    );

    // One unambiguous live membership repairs a missed first-join event.
    slack.channels = ["CA"];
    const repaired = await resolveChannel(store, slackClient);
    assert.equal(repaired.channelId, "CA");
    assert.equal(repaired.initializedRoute, true);
    assert.equal(await store.getSelectedChannelId("TROUTE"), "CA");

    // Additional memberships never change the explicit route.
    slack.channels = ["CA", "CB"];
    const existing = await resolveChannel(store, slackClient);
    assert.equal(existing.channelId, "CA");
    assert.equal(existing.initializedRoute, false);

    // Removing the selected channel does not fail over to another membership.
    slack.channels = ["CB"];
    await assert.rejects(
      resolveChannel(store, slackClient),
      (err: unknown) =>
        err instanceof ChannelResolutionError &&
        err.message === slackSelectedChannelUnavailableMessage("CA"),
    );

    // Rejoining restores the retained route; an explicit switch changes it.
    slack.channels = ["CA", "CB"];
    assert.equal((await resolveChannel(store, slackClient)).channelId, "CA");
    await store.setMention({ teamId: "TROUTE", channelId: "CB", mention: "<!here>", updatedBy: "U1" });
    await store.setApprovers({ teamId: "TROUTE", channelId: "CB", approvers: ["U2"], updatedBy: "U1" });
    await store.selectTeamChannel({ teamId: "TROUTE", channelId: "CB" });
    assert.equal((await resolveChannel(store, slackClient)).channelId, "CB");
    assert.deepEqual(await store.getChannelSettings("TROUTE", "CB"), {
      mention: "<!here>",
      approvers: ["U2"],
    });
    await store.selectTeamChannel({ teamId: "TROUTE", channelId: "CB" });
    assert.equal(
      await store.setSelectedChannelMention({
        teamId: "TROUTE",
        expectedChannelId: "CA",
        mention: "",
        updatedBy: "U3",
      }),
      false,
    );

    // Several memberships with no route are intentionally ambiguous.
    const ambiguous = makeSlackStub({ teamId: "TAMBIG", channels: ["CX", "CY"] });
    await assert.rejects(
      resolveChannel(store, ambiguous as never as SlackClient),
      (err: unknown) =>
        err instanceof ChannelResolutionError && err.message === SLACK_MULTIPLE_CHANNELS_MESSAGE,
    );
    assert.equal(await store.getSelectedChannelId("TAMBIG"), null);

    // Concurrent first joins serialize; exactly one initializes the route.
    const initializations = await Promise.all([
      store.initializeTeamChannelRoute({ teamId: "TRACEINIT", channelId: "C1" }),
      store.initializeTeamChannelRoute({ teamId: "TRACEINIT", channelId: "C2" }),
    ]);
    assert.equal(initializations.filter((result) => result.initializedRoute).length, 1);
  }

  // --- Start onboarding is read-only; video owns missed-event initialization ---
  {
    const slack = makeSlackStub({ teamId: "TSTARTREAD", channels: ["CSTARTREAD"] });
    const app = makeApp(makeGithubStub(), slack);
    const start = (await startRun(app, makeStart(19, { headSha: "startread01" }))).body;
    assert.equal(start.onboarded, true);
    assert.equal(await store.getSelectedChannelId("TSTARTREAD"), null);
    assert.equal((await postVideo(app, start.cycleId!, start.attemptId)).res.statusCode, 200);
    assert.equal(await store.getSelectedChannelId("TSTARTREAD"), "CSTARTREAD");
    assert.deepEqual(slack.postMessageCalls, [
      { channel: "CSTARTREAD", text: SLACK_GREETING_ACTIVE },
    ]);

    // A delayed join event loses route initialization and does not duplicate
    // the greeting emitted by the missed-event fallback.
    await postSlackEvent(
      app,
      membershipEvent({
        type: "member_joined_channel",
        teamId: "TSTARTREAD",
        user: "UBOT",
        channel: "CSTARTREAD",
        ts: "1767225600.000000",
      }),
    );
    await sleep(50);
    assert.equal(slack.postMessageCalls.length, 1);
  }

  // --- Shared tenant channel: repos share the active channel; mention default ---
  {
    const slack = makeSlackStub();
    const app = makeApp(makeGithubStub(), slack);
    const first = (await startRun(app, makeStart(20, { headSha: "shared0001" }))).body;
    const second = (
      await startRun(app, makeStart(21, { repo: "OtherRepo", headSha: "shared0002" }))
    ).body;
    assert.ok(first.cycleId && first.attemptId);
    assert.ok(second.cycleId && second.attemptId);
    // Advisory flag: a tenant with an active channel reports onboarded.
    assert.equal(first.onboarded, true);
    assert.equal(second.onboarded, true);
    await postVideo(app, first.cycleId!, first.attemptId);
    await postVideo(app, second.cycleId!, second.attemptId);
    assert.deepEqual(slack.postValidationArgs, [
      { channel: "C0123", mention: null },
      { channel: "C0123", mention: null },
    ]);
    assert.deepEqual(slack.uploadVideoChannels, ["C0123", "C0123"]);
  }

  // --- Validation mention comes from the channel settings at post time ---
  {
    const slack = makeSlackStub({ teamId: "TMENTION", channels: ["CM1"] });
    const app = makeApp(makeGithubStub(), slack);
    await store.setMention({
      teamId: "TMENTION",
      channelId: "CM1",
      mention: "<!subteam^S321|@design>",
      updatedBy: "U1",
    });
    const start = (await startRun(app, makeStart(22, { headSha: "mention0001" }))).body;
    await postVideo(app, start.cycleId!, start.attemptId);
    assert.deepEqual(slack.postValidationArgs, [
      { channel: "CM1", mention: "<!subteam^S321|@design>" },
    ]);
  }

  // --- Video delivery observes explicit switches and never falls back ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub({ teamId: "TVIDEO", channels: ["CVIDEO1", "CVIDEO2"] });
    const app = makeApp(github, slack);
    await store.initializeTeamChannelRoute({ teamId: "TVIDEO", channelId: "CVIDEO1" });

    const switched = (await startRun(app, makeStart(220, { headSha: "switchvid01" }))).body;
    await store.selectTeamChannel({ teamId: "TVIDEO", channelId: "CVIDEO2" });
    const switchedVideo = await postVideo(app, switched.cycleId!, switched.attemptId);
    assert.equal(switchedVideo.res.statusCode, 200);
    assert.deepEqual(slack.uploadVideoChannels, ["CVIDEO2"]);

    const unavailable = (await startRun(app, makeStart(221, { headSha: "unavailvid1" }))).body;
    slack.channels = ["CVIDEO1"];
    const unavailableVideo = await postVideo(
      app,
      unavailable.cycleId!,
      unavailable.attemptId,
    );
    const unavailableMessage = slackSelectedChannelUnavailableMessage("CVIDEO2");
    assert.equal(unavailableVideo.res.statusCode, 422);
    assert.equal(unavailableVideo.body.message, unavailableMessage);
    assert.equal(github.checkRuns.get(unavailable.checkRunId!)?.summary, unavailableMessage);
    assert.deepEqual(slack.uploadVideoChannels, ["CVIDEO2"]);

    const rejoined = (await startRun(app, makeStart(222, { headSha: "rejoinvid01" }))).body;
    slack.channels = ["CVIDEO1", "CVIDEO2"];
    assert.equal((await postVideo(app, rejoined.cycleId!, rejoined.attemptId)).res.statusCode, 200);
    assert.deepEqual(slack.uploadVideoChannels, ["CVIDEO2", "CVIDEO2"]);
  }

  // --- Events: first join greets once; later joins and leaves are silent ---
  {
    const slack = makeSlackStub({ teamId: "TEVT", channels: [] });
    const app = makeApp(makeGithubStub(), slack);

    const challenge = await postSlackEvent(app, { type: "url_verification", challenge: "chal123" });
    assert.equal(challenge.statusCode, 200);
    assert.equal((JSON.parse(challenge.body) as { challenge?: string }).challenge, "chal123");

    const badSig = await app.inject({
      method: "POST",
      url: "/api/slack/events",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=bad",
      },
      payload: JSON.stringify({ type: "url_verification", challenge: "nope" }),
    });
    assert.equal(badSig.statusCode, 401);

    const firstJoin = {
      ...membershipEvent({
        type: "member_joined_channel" as const,
        teamId: "TEVT",
        user: "UBOT",
        channel: "CE1",
        ts: "1767225601.000000",
      }),
      event_id: "Ev0FIRSTJOIN",
    };
    slack.channels = ["CE1"];
    const listBotChannels = slack.listBotChannels;
    const getSelectedChannelId = store.getSelectedChannelId.bind(store);
    let membershipSweepCompleted = false;
    let greetingRouteReadAfterMembership: boolean | undefined;
    slack.listBotChannels = async () => {
      await sleep(10);
      membershipSweepCompleted = true;
      return listBotChannels();
    };
    store.getSelectedChannelId = async (teamId: string) => {
      if (teamId === "TEVT") greetingRouteReadAfterMembership = membershipSweepCompleted;
      return getSelectedChannelId(teamId);
    };
    await postSlackEvent(app, firstJoin);
    assert.ok(await waitFor(async () => greetingRouteReadAfterMembership !== undefined));
    assert.equal(greetingRouteReadAfterMembership, true);
    assert.ok(await waitFor(async () => slack.postMessageCalls.length === 1));
    slack.listBotChannels = listBotChannels;
    store.getSelectedChannelId = getSelectedChannelId;
    assert.deepEqual(slack.postMessageCalls[0], {
      channel: "CE1",
      text: SLACK_GREETING_ACTIVE,
    });
    assert.equal(await store.getSelectedChannelId("TEVT"), "CE1");

    // A retried first join and every later join are silent.
    await postSlackEvent(app, firstJoin);
    for (const [channel, ts] of [
      ["CE2", "1767225602.000000"],
      ["CE3", "1767225603.000000"],
    ] as const) {
      slack.channels.push(channel);
      await postSlackEvent(
        app,
        membershipEvent({
          type: "member_joined_channel",
          teamId: "TEVT",
          user: "UBOT",
          channel,
          ts,
        }),
      );
    }

    // Non-bot joins and obsolete leave events are ignored.
    await postSlackEvent(
      app,
      membershipEvent({
        type: "member_joined_channel",
        teamId: "TEVT",
        user: "UHUMAN",
        channel: "CE4",
        ts: "1767225604.000000",
      }),
    );
    await postSlackEvent(
      app,
      membershipEvent({
        type: "member_left_channel",
        teamId: "TEVT",
        user: "UBOT",
        channel: "CE1",
        ts: "1767225605.000000",
      }),
    );
    await sleep(150);
    assert.equal(slack.postMessageCalls.length, 1);
    assert.equal(await store.getSelectedChannelId("TEVT"), "CE1");

    // Runtime events never write legacy membership rows.
    const probe = new Client({ connectionString: testUrl });
    await probe.connect();
    const legacyRows = await probe.query<{ count: string }>(
      "select count(*) from bot_channels where team_id = $1",
      ["TEVT"],
    );
    await probe.end();
    assert.equal(legacyRows.rows[0].count, "0");
  }

  // --- Commands: mention set/echo/bad-handle, approvers, status, usage ---
  {
    const slack = makeSlackStub({ teamId: "TCMD", channels: ["CCMD"] });
    slack.usergroups = [{ id: "S777", handle: "product-team" }];
    slack.usergroupMembers = { S777: ["U222"] };
    slack.channelMembers = { CCMD: ["UCMD", "U111", "U222"] };
    const app = makeApp(makeGithubStub(), slack);
    let commandNumber = 0;
    const run = async (
      text: string,
      channelId = "CCMD",
      teamId = "TCMD",
      userId = "UCMD",
    ) => {
      commandNumber += 1;
      const responseUrl = `https://hooks.slack.test/command/${commandNumber}`;
      const res = await postCommand(app, {
        teamId,
        channelId,
        userId,
        text,
        responseUrl,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, "");
      assert.ok(
        await waitFor(async () =>
          slack.ephemeralCalls.some((message) => message.url === responseUrl),
        ),
      );
      const message = slack.ephemeralCalls.find((candidate) => candidate.url === responseUrl);
      return { res, body: { response_type: "ephemeral", text: message?.text } };
    };

    assert.equal(
      (await run("status")).body.text,
      "Feature-Rec is already present in <#CCMD>, but no review channel is selected. Run `/feature-rec channel #channel-name` to select it.",
    );
    assert.equal(
      (await run("channel <#CCMD|reviews>")).body.text,
      "Feature-Rec videos will now be sent to <#CCMD>. Existing mention and approver settings for that channel are unchanged.",
    );
    assert.equal(slack.postMessageCalls.length, 0);
    assert.equal(
      (await run("channel")).body.text,
      "Usage: `/feature-rec channel #channel-name`.",
    );
    assert.equal(
      (await run("channel #reviews")).body.text,
      "Usage: `/feature-rec channel #channel-name`.",
    );
    assert.equal(
      (await run("channel <#CCMD> <#CCMD2>")).body.text,
      "Usage: `/feature-rec channel #channel-name`.",
    );
    assert.equal(
      (await run("channel <#CABSENT|absent>")).body.text,
      "Invite @Feature-Rec to <#CABSENT>, then try again.",
    );

    // Selection works from a conversation without the bot and from a DM,
    // accepts private channels, and preserves target-channel settings.
    await store.setMention({
      teamId: "TCMD",
      channelId: "CCMD2",
      mention: "<!channel>",
      updatedBy: "UOLD",
    });
    await store.setApprovers({
      teamId: "TCMD",
      channelId: "CCMD2",
      approvers: ["U111"],
      updatedBy: "UOLD",
    });
    slack.channels = ["CCMD", "CCMD2", "GPRIVATE"];
    await run("channel <#CCMD2|other>", "CWITHOUTBOT", "TCMD", "UANYONE");
    assert.deepEqual(await store.getChannelSettings("TCMD", "CCMD2"), {
      mention: "<!channel>",
      approvers: ["U111"],
    });
    await run("channel <#GPRIVATE|private>", "D123", "TCMD", "UANYONE");
    assert.equal(await store.getSelectedChannelId("TCMD"), "GPRIVATE");
    await run("channel <#CCMD|reviews>", "D123", "TCMD", "UANYONE");
    assert.equal(slack.postMessageCalls.length, 0);
    assert.equal(
      (await run("status", "CCMD", "TOTHER")).body.text,
      "This command belongs to a different Slack workspace.",
    );
    slack.channels = ["CCMD"];

    assert.equal((await run("mention")).body.text, "Mention for <#CCMD>: @here (default)");

    const set = await run("mention @product-team <@U111|bob>");
    assert.equal(
      set.body.text,
      "Validation requests in <#CCMD> will mention <!subteam^S777|@product-team> <@U111>.",
    );
    assert.equal(
      (await store.getChannelSettings("TCMD", "CCMD"))?.mention,
      "<!subteam^S777|@product-team> <@U111>",
    );

    const missingUser = await run("mention <@UMISSING|missing>");
    assert.ok(missingUser.body.text?.includes("<@UMISSING> is not a member"));
    assert.equal(
      (await store.getChannelSettings("TCMD", "CCMD"))?.mention,
      "<!subteam^S777|@product-team> <@U111>",
    );
    slack.usergroupMembers.S777 = ["U222", "UMISSING"];
    const incompleteGroup = await run("mention @product-team");
    assert.ok(incompleteGroup.body.text?.includes("<@UMISSING> is not a member"));
    slack.usergroupMembers.S777 = ["U222"];
    assert.equal(
      (await run("mention")).body.text,
      "Mention for <#CCMD>: <!subteam^S777|@product-team> <@U111>",
    );

    const badHandle = await run("mention @nope");
    assert.ok(badHandle.body.text?.startsWith("Unknown mention target @nope."));
    assert.equal(
      (await store.getChannelSettings("TCMD", "CCMD"))?.mention,
      "<!subteam^S777|@product-team> <@U111>",
    );

    assert.equal(
      (await run("mention @here")).body.text,
      "Validation requests in <#CCMD> will mention <!here>.",
    );
    assert.equal((await store.getChannelSettings("TCMD", "CCMD"))?.mention, "<!here>");
    assert.ok((await run("mention off")).body.text?.startsWith("Unknown mention target off."));
    assert.equal((await store.getChannelSettings("TCMD", "CCMD"))?.mention, "<!here>");

    // Existing empty mention settings remain readable and can be overwritten,
    // but the command no longer creates them.
    await store.setMention({
      teamId: "TCMD",
      channelId: "CCMD",
      mention: "",
      updatedBy: "ULEGACY",
    });
    assert.equal((await store.getChannelSettings("TCMD", "CCMD"))?.mention, "");
    assert.equal((await run("mention")).body.text, "Mention for <#CCMD>: off");

    assert.equal(
      (await run("approvers")).body.text,
      "For <#CCMD>: Approvers: everyone in the channel.",
    );
    assert.equal(
      (await run("approvers @product-team <@U111|bob>")).body.text,
      "Only <!subteam^S777>, <@U111> can approve in <#CCMD>.",
    );
    assert.deepEqual((await store.getChannelSettings("TCMD", "CCMD"))?.approvers, [
      "S777",
      "U111",
    ]);
    assert.ok((await run("approvers @nobody")).body.text?.startsWith("Unknown approver @nobody."));
    slack.usergroups.push({ id: "SEMPTY", handle: "empty-team" });
    assert.equal(
      (await run("approvers @empty-team")).body.text,
      "Usergroup @empty-team has no users and cannot be selected.",
    );
    assert.equal(
      (await run("approvers @channel <@U111|bob>")).body.text,
      "Use @channel by itself: `/feature-rec approvers @channel`.",
    );
    assert.deepEqual((await store.getChannelSettings("TCMD", "CCMD"))?.approvers, [
      "S777",
      "U111",
    ]);
    assert.equal(
      (await run("approvers <!channel>")).body.text,
      "Everyone in <#CCMD> can now approve.",
    );
    assert.equal((await store.getChannelSettings("TCMD", "CCMD"))?.approvers, null);
    assert.ok(
      (await run("approvers everyone")).body.text?.startsWith("Unknown approver everyone."),
    );
    assert.ok((await run("approvers off")).body.text?.startsWith("Unknown approver off."));

    slack.channels = ["CCMD", "CCMD2"];
    const status = (await run("status")).body.text ?? "";
    assert.ok(status.includes("Selected review channel: <#CCMD> (available)."));
    assert.ok(status.includes("Mention: off"));
    assert.ok(status.includes("Approvers: everyone in the channel."));
    assert.equal(status.includes("will move"), false);

    slack.channels = ["CCMD2"];
    const unavailableStatus = (await run("status")).body.text ?? "";
    assert.ok(unavailableStatus.includes("Selected review channel: <#CCMD> (unavailable)."));
    assert.ok(unavailableStatus.includes("Invite @Feature-Rec back"));
    assert.equal(
      (await run("mention @here")).body.text,
      slackSelectedChannelUnavailableMessage("CCMD"),
    );
    slack.channels = ["CCMD", "CCMD2"];

    assert.ok((await run("wat")).body.text?.startsWith("Usage:"));
    assert.ok((await run("")).body.text?.startsWith("Usage:"));

    // The ack must not wait for the status command's Slack membership sweep.
    let releaseStatus: (() => void) | undefined;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const listBotChannels = slack.listBotChannels;
    slack.listBotChannels = async () => {
      await statusGate;
      return listBotChannels();
    };
    const slowResponseUrl = "https://hooks.slack.test/command/slow-status";
    const slowAck = await Promise.race([
      postCommand(app, {
        teamId: "TCMD",
        channelId: "CCMD",
        userId: "UCMD",
        text: "status",
        responseUrl: slowResponseUrl,
      }),
      sleep(250).then(() => null),
    ]);
    assert.ok(slowAck, "slash command ack waited for status work");
    assert.equal(slowAck.statusCode, 200);
    assert.equal(slowAck.body, "");
    assert.equal(
      slack.ephemeralCalls.some((message) => message.url === slowResponseUrl),
      false,
    );
    releaseStatus?.();
    assert.ok(
      await waitFor(async () =>
        slack.ephemeralCalls.some((message) => message.url === slowResponseUrl),
      ),
    );
    slack.listBotChannels = listBotChannels;

    // Unexpected command failures still produce a useful ephemeral response.
    slack.listBotChannels = async () => {
      throw new Error("command dependency failed");
    };
    assert.equal(
      (await run("status")).body.text,
      "Something went wrong. Please try again.",
    );
    slack.listBotChannels = listBotChannels;

    const badCommandSig = await app.inject({
      method: "POST",
      url: "/api/slack/commands",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=bad",
      },
      payload: "team_id=TCMD&channel_id=CCMD&user_id=UCMD&text=status",
    });
    assert.equal(badCommandSig.statusCode, 401);

    const missingTeam =
      "channel_id=CCMD&user_id=UCMD&text=status&response_url=https%3A%2F%2Fhooks.slack.test%2Fcommand%2Fmissing-team";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const noTeam = await app.inject({
      method: "POST",
      url: "/api/slack/commands",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signSlack(missingTeam, timestamp),
      },
      payload: missingTeam,
    });
    assert.equal(noTeam.statusCode, 400);

    const missingResponseUrl = "team_id=TCMD&channel_id=CCMD&user_id=UCMD&text=status";
    const missingResponseTimestamp = String(Math.floor(Date.now() / 1000));
    const noResponseUrl = await app.inject({
      method: "POST",
      url: "/api/slack/commands",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": missingResponseTimestamp,
        "x-slack-signature": signSlack(missingResponseUrl, missingResponseTimestamp),
      },
      payload: missingResponseUrl,
    });
    assert.equal(noResponseUrl.statusCode, 400);
  }

  // --- Restricted approval: non-approver gets an ephemeral reply, member accepts ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    slack.usergroupMembers = { S900: ["UMEMBER"] };
    const app = makeApp(github, slack);
    const start = (await startRun(app, makeStart(23, { headSha: "restrict01" }))).body;
    await postVideo(app, start.cycleId!, start.attemptId);
    await store.setApprovers({
      teamId: "TAPPR",
      channelId: "C0123",
      approvers: ["S900"],
      updatedBy: "UADMIN",
    });

    await postBlockAction(app, {
      cycleId: start.cycleId!,
      headSha: "restrict01",
      action: "accept",
      actionTs: "1710000000.000101",
      triggerId: "TR1",
      userId: "USTRANGER",
      teamId: "TAPPR",
      responseUrl: "https://hooks.slack.test/r1",
    });
    assert.ok(await waitFor(async () => slack.ephemeralCalls.length === 1));
    assert.deepEqual(slack.ephemeralCalls[0], {
      url: "https://hooks.slack.test/r1",
      text: "Only <!subteam^S900> can approve.",
    });
    await sleep(150);
    assert.equal(github.acceptCalls, 0);
    assert.equal((await store.getCycle(start.cycleId!))?.status, "pending_validation");

    await postBlockAction(app, {
      cycleId: start.cycleId!,
      headSha: "restrict01",
      action: "accept",
      actionTs: "1710000000.000102",
      triggerId: "TR2",
      userId: "UMEMBER",
      teamId: "TAPPR",
      responseUrl: "https://hooks.slack.test/r2",
    });
    assert.ok(
      await waitFor(async () => (await store.getCycle(start.cycleId!))?.status === "accepted"),
    );
    await sleep(150);
    assert.equal(github.acceptCalls, 1);
    assert.equal(slack.ephemeralCalls.length, 1);
  }

  // --- Request-changes submissions: empty comment, unauthorized, rejection ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    slack.usergroupMembers = { S900: ["UMEMBER"] };
    const app = makeApp(github, slack);
    const start = (await startRun(app, makeStart(26, { headSha: "reject0001" }))).body;
    await postVideo(app, start.cycleId!, start.attemptId);
    // TAPPR/C0123 approvers were set to ["S900"] in the restricted-approval block.

    const emptyComment = await postViewSubmission(app, {
      cycleId: start.cycleId!,
      headSha: "reject0001",
      viewId: "V1",
      comment: "  ",
      userId: "UMEMBER",
      teamId: "TAPPR",
    });
    assert.equal(
      (JSON.parse(emptyComment.body) as { response_action?: string }).response_action,
      "errors",
    );

    // Unauthorized submission replies through the response_url stashed in the
    // modal's private_metadata (view payloads carry none of their own).
    await postViewSubmission(app, {
      cycleId: start.cycleId!,
      headSha: "reject0001",
      viewId: "V2",
      comment: "not premium enough",
      userId: "USTRANGER",
      teamId: "TAPPR",
      responseUrl: "https://hooks.slack.test/r3",
    });
    assert.ok(await waitFor(async () => slack.ephemeralCalls.length === 1));
    assert.deepEqual(slack.ephemeralCalls[0], {
      url: "https://hooks.slack.test/r3",
      text: "Only <!subteam^S900> can approve.",
    });
    await sleep(150);
    assert.equal(github.rejectCalls, 0);
    assert.equal((await store.getCycle(start.cycleId!))?.status, "pending_validation");

    await postViewSubmission(app, {
      cycleId: start.cycleId!,
      headSha: "reject0001",
      viewId: "V3",
      comment: "not premium enough",
      userId: "UMEMBER",
      teamId: "TAPPR",
      responseUrl: "https://hooks.slack.test/r4",
    });
    assert.ok(
      await waitFor(async () => (await store.getCycle(start.cycleId!))?.status === "rejected"),
    );
    await sleep(150);
    assert.equal(github.rejectCalls, 1);
    assert.equal(slack.finalizeCalls.at(-1)?.state, "rejected");
  }

  // --- Real SlackClient.listBotChannels: pagination, membership as reported ---
  // No shared-channel filtering: every channel users.conversations reports is
  // returned, externally shared and pending ones included (the setup guide
  // warns against inviting the bot to Slack Connect channels).
  {
    const previousFetch = globalThis.fetch;
    const pages = [
      {
        ok: true,
        channels: [{ id: "CP1" }, { id: "CP2", is_ext_shared: true }],
        response_metadata: { next_cursor: "cur2" },
      },
      {
        ok: true,
        channels: [{ id: "CP3", is_pending_ext_shared: true }, { id: "CP4" }],
        response_metadata: { next_cursor: "" },
      },
    ];
    const cursors: Array<string | undefined> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { cursor?: string };
      cursors.push(body.cursor);
      return new Response(JSON.stringify(pages[cursors.length - 1]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new SlackClient({ ...env, slackBotToken: "xoxb-test" });
      assert.deepEqual(await client.listBotChannels(), ["CP1", "CP2", "CP3", "CP4"]);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.deepEqual(cursors, [undefined, "cur2"]);
  }

  // --- Real SlackClient.listChannelMembers: cursor pagination ---
  {
    const previousFetch = globalThis.fetch;
    const requests: Array<{ channel?: string; cursor?: string; limit?: number }> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        channel?: string;
        cursor?: string;
        limit?: number;
      };
      requests.push(body);
      const page = requests.length === 1
        ? { ok: true, members: ["U1", "U2"], response_metadata: { next_cursor: "members2" } }
        : { ok: true, members: ["U3"], response_metadata: { next_cursor: "" } };
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new SlackClient({ ...env, slackBotToken: "xoxb-test" });
      assert.deepEqual(await client.listChannelMembers("CMEMBERS"), ["U1", "U2", "U3"]);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.deepEqual(requests, [
      { channel: "CMEMBERS", limit: 200 },
      { channel: "CMEMBERS", cursor: "members2", limit: 200 },
    ]);
  }

  // --- Real SlackClient.listUsergroups: disabled groups are excluded upstream ---
  {
    const previousFetch = globalThis.fetch;
    let requestBody: { include_disabled?: boolean } | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as { include_disabled?: boolean };
      return new Response(
        JSON.stringify({ ok: true, usergroups: [{ id: "SENABLED", handle: "enabled" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const client = new SlackClient({ ...env, slackBotToken: "xoxb-test" });
      assert.deepEqual(await client.listUsergroups(), [
        { id: "SENABLED", handle: "enabled" },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.deepEqual(requestBody, { include_disabled: false });
  }

  // --- Real SlackClient.isApprover: direct ids skip the API, groups expand ---
  {
    const previousFetch = globalThis.fetch;
    const usergroupCalls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      usergroupCalls.push(String(url));
      const body = init?.body ? (JSON.parse(String(init.body)) as { usergroup?: string }) : {};
      assert.equal(body.usergroup, "S123");
      return new Response(JSON.stringify({ ok: true, users: ["U1", "U2"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new SlackClient({ ...env, slackBotToken: "xoxb-test" });
      assert.equal(await client.isApprover(null, "Uany"), true);
      assert.equal(await client.isApprover(["U9"], undefined), false);
      assert.equal(await client.isApprover(["U9"], "U9"), true);
      assert.equal(await client.isApprover(["S123"], "U1"), true);
      assert.equal(await client.isApprover(["S123"], "U7"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.equal(usergroupCalls.length, 2);
  }

  // --- Video with no review channel: 422, actionable check run, /failed no-ops ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub({ teamId: "TEMPTY", channels: [] });
    const app = makeApp(github, slack);
    const start = (await startRun(app, makeStart(24, { headSha: "nochannel1" }))).body;
    // Advisory flag: an unboarded tenant is announced at start so the runner
    // can fail frontend-visible PRs before rendering.
    assert.equal(start.onboarded, false);

    const video = await postVideo(app, start.cycleId!, start.attemptId);
    assert.equal(video.res.statusCode, 422);
    assert.equal(video.body.error, "no_slack_channel");
    // Machine-readable settlement: the backend already failed the cycle and
    // wrote the check run, so the runner must skip its own failure report.
    assert.equal(video.body.settled, true);
    assert.equal((await store.getCycle(start.cycleId!))?.status, "failed");
    assert.equal(github.checkRuns.get(start.checkRunId!)?.conclusion, "failure");
    assert.equal(slack.uploadVideoCalls, 0);

    const failed = await postResult(app, start.cycleId!, "failed", { attemptId: start.attemptId });
    assert.equal(failed.body.stale, true);
    assert.equal(github.checkRuns.get(start.checkRunId!)?.conclusion, "failure");
  }

  // --- Superseded while resolving the channel: no failure written over neutral ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub({ teamId: "TRACE", channels: [] });
    const app = makeApp(github, slack);
    const startA = (await startRun(app, makeStart(25, { headSha: "race0001aa" }))).body;

    // The membership poll starts a newer head before reporting no channels,
    // so A is superseded mid-resolution.
    slack.listBotChannels = async () => {
      await startRun(app, makeStart(25, { headSha: "race0002bb" }));
      return [];
    };
    const video = await postVideo(app, startA.cycleId!, startA.attemptId);
    assert.equal(video.res.statusCode, 200);
    assert.equal(video.body.stale, true);
    assert.equal((await store.getCycle(startA.cycleId!))?.status, "superseded");
    assert.ok(
      await waitFor(
        async () => github.checkRuns.get(startA.checkRunId!)?.conclusion === "neutral",
      ),
    );
  }

  // --- Route/store invariants: no settings side effect, isolation, switching ---
  {
    const first = await store.initializeTeamChannelRoute({
      teamId: "TSTORE",
      channelId: "CSTORE1",
    });
    const second = await store.initializeTeamChannelRoute({
      teamId: "TSTORE",
      channelId: "CSTORE2",
    });
    assert.equal(first.initializedRoute, true);
    assert.equal(second.initializedRoute, false);
    assert.equal(await store.getSelectedChannelId("TSTORE"), "CSTORE1");
    assert.equal(await store.getChannelSettings("TSTORE", "CSTORE1"), null);

    await store.setMention({
      teamId: "TSTORE",
      channelId: "CSTORE2",
      mention: "<!channel>",
      updatedBy: "U1",
    });
    await store.setApprovers({
      teamId: "TSTORE",
      channelId: "CSTORE2",
      approvers: ["U2"],
      updatedBy: "U1",
    });
    await Promise.all([
      store.selectTeamChannel({ teamId: "TSTORE", channelId: "CSTORE2" }),
      store.selectTeamChannel({ teamId: "TSTORE", channelId: "CSTORE3" }),
    ]);
    const selectedChannelId = await store.getSelectedChannelId("TSTORE");
    assert.ok(selectedChannelId === "CSTORE2" || selectedChannelId === "CSTORE3");
    assert.deepEqual(await store.getChannelSettings("TSTORE", "CSTORE2"), {
      mention: "<!channel>",
      approvers: ["U2"],
    });

    await store.initializeTeamChannelRoute({
      teamId: "TSTORE-OTHER",
      channelId: "COTHER",
    });
    assert.equal(
      await store.getSelectedChannelId("TSTORE-OTHER"),
      "COTHER",
    );
  }

  // --- Advisory onboarding probe failure cannot stall the start ---
  {
    // The Slack sweep throwing must not 500 the start: the cycle would stay
    // `analyzing` with no attemptId returned, and retries would exit as
    // duplicates forever. Unknown onboarding → flag omitted, start succeeds.
    const slack = makeSlackStub({ teamId: "TPROBE", channels: [] });
    slack.listBotChannels = async () => {
      throw new Error("slack is down");
    };
    const app = makeApp(makeGithubStub(), slack);
    const start = await startRun(app, makeStart(26, { headSha: "probe00001" }));
    assert.equal(start.res.statusCode, 200);
    assert.ok(start.body.attemptId);
    assert.equal(start.body.onboarded, undefined);
  }

  // --- Writes after close() reject (pg pool, not a synchronous throw) ---
  {
    // init() first so the (lazily-created) pool is actually opened; otherwise
    // close() is a no-op and the write below would succeed against a live pool.
    const closeStore = new PostgresCycleStore(testUrl);
    await closeStore.init();
    await closeStore.close();
    await assert.rejects(closeStore.recordProcessedInteraction("after-close", "none"));
  }

  console.log("service selftest passed");
} finally {
  // Close the app + store/pool before dropping so no live client receives the
  // termination; FORCE is a belt-and-braces against any lingering connection so
  // a failed run can't strand the test database.
  await Promise.allSettled(apps.map((app) => app.close()));
  await store.close().catch(() => {});
  const dropper = new Client({ connectionString: adminUrl });
  await dropper.connect();
  await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await dropper.end();
}
