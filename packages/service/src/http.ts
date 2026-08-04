import Fastify from "fastify";
import crypto from "node:crypto";
import {
  buildCycleKey,
  ClassifierResultSchema,
  RunStartRequestSchema,
  SlackApprovalPayloadSchema,
  SLACK_GREETING_ACTIVE,
  SLACK_MULTIPLE_CHANNELS_MESSAGE,
  SLACK_NO_CHANNEL_MESSAGE,
  slackSelectedChannelUnavailableMessage,
} from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import {
  describeChannelSettings,
  effectiveMention,
  formatApproverList,
  joinList,
} from "./channel-settings";
import { ChannelResolutionError, resolveChannel } from "./channels";
import { GitHubClient } from "./github";
import { withRetry } from "./retry";
import { SlackClient, verifySlackSignature } from "./slack";
import type { SlackUsergroup } from "./slack";
import { DEFAULT_CHANNEL_SETTINGS, type CycleRecord, type CycleStore } from "./storage";

const VIDEO_BODY_LIMIT_BYTES = 500 * 1024 * 1024;

type SlackPayload = {
  type: "block_actions" | "view_submission";
  trigger_id?: string;
  response_url?: string;
  team?: { id?: string };
  user?: { id?: string; username?: string; name?: string };
  actions?: Array<{ action_id?: string; action_ts?: string; value?: string }>;
  view?: {
    id?: string;
    hash?: string;
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string }>>;
    };
  };
};

type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    user?: string;
    channel?: string;
    event_ts?: string;
  };
};

function param(params: unknown, key: string): string {
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing parameter ${key}`);
  return value;
}

// Slash-command target syntax. With "Escape channels, users, and links"
// enabled on the command, channel/user mentions arrive with stable IDs;
// usergroups and @here/@channel arrive as typed.
const USER_MENTION_RE = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;
const SUBTEAM_MENTION_RE = /^<!subteam\^(S[A-Z0-9]+)(?:\|[^>]*)?>$/;
const CHANNEL_MENTION_RE = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/;

// A user-correctable command mistake: the message goes back ephemerally
// instead of becoming a 500.
class CommandError extends Error {}

const GENERAL_HELP = [
  "Feature-Rec commands:",
  "`/feature-rec channel [#channel]` — select or show the review channel",
  "`/feature-rec mention [approvers|off|@audience…]` — who validation requests mention",
  "`/feature-rec approvers [@channel|@audience…]` — who may approve",
  "`/feature-rec status` — show the selected channel and settings",
  "`/feature-rec help` — show this help",
].join("\n");

const CHANNEL_HELP = [
  "Usage: `/feature-rec channel #channel-name`",
  "Select a public or private channel that @Feature-Rec has joined.",
  "Each channel keeps its own approver and notification settings.",
].join("\n");

const MENTION_HELP = [
  "Usage:",
  "`/feature-rec mention approvers` — mention the channel's current approvers (default)",
  "`/feature-rec mention off` — post validation requests without mentioning anyone",
  "`/feature-rec mention @here|@channel|@usergroup|@user…` — mention a custom audience",
  "`@channel` must be used alone; `@here` may be combined with users or groups.",
].join("\n");

const APPROVERS_HELP = [
  "Usage: `/feature-rec approvers @channel|@usergroup|@user…`",
  "`@channel` allows anyone in the channel to approve.",
  "Otherwise only the listed users and usergroup members may approve.",
].join("\n");

const COMMAND_FAILED = "Something went wrong. Please try again.";

function rawJsonBody(body: unknown): string {
  if (body && typeof body === "object") {
    const raw = (body as { __rawBody?: unknown }).__rawBody;
    if (typeof raw === "string") return raw;
  }
  return "";
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function classifierSummary(raw: unknown): string {
  const result = ClassifierResultSchema.safeParse(raw);
  if (!result.success) return "";
  return [
    `Classifier: ${result.data.frontendVisible ? "frontend-visible" : "not frontend-visible"}`,
    `Confidence: ${result.data.confidence}`,
    result.data.reason,
    result.data.userImpact,
  ]
    .filter(Boolean)
    .join("\n");
}

function runnerAuthorized(env: ServiceEnv, header: unknown): boolean {
  if (!env.runnerToken || typeof header !== "string") return false;
  return timingSafeStringEqual(header, `Bearer ${env.runnerToken}`);
}

function bodyAttemptId(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const value = (body as { attemptId?: unknown }).attemptId;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function headerAttemptId(header: unknown): string | undefined {
  return typeof header === "string" && header ? header : undefined;
}

export function buildServer(input: {
  env: ServiceEnv;
  store: CycleStore;
  github?: GitHubClient;
  slack?: SlackClient;
}) {
  const env = input.env;
  const store = input.store;
  const github = input.github ?? new GitHubClient(env);
  const slack = input.slack ?? new SlackClient(env);
  const app = Fastify({ logger: true });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const rawBody = String(body);
        const parsed = rawBody ? JSON.parse(rawBody) : {};
        if (parsed && typeof parsed === "object") {
          Object.defineProperty(parsed, "__rawBody", {
            value: rawBody,
            enumerable: false,
          });
        }
        done(null, parsed);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/runs/start", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const start = RunStartRequestSchema.parse(request.body);
    const cycleKey = buildCycleKey(start);
    const result = await store.startCycle({ ...start, cycleKey });

    // Duplicate start for the same head: clean no-op exit. No check run is
    // created and no attemptId is issued, so this runner holds no ownership.
    // (Duplicates always have an empty superseded[], so no cleanup is skipped.)
    if (!result.created) {
      return { duplicate: true, cycleId: result.cycle.id, cycleKey };
    }

    // Finalize the superseded losers. Fire-and-forget, best-effort by design:
    // cleanup of old cycles must never delay or fail the active runner's /start
    // response. The committed DB status (superseded) is authoritative; each
    // cycle's errors are caught and logged, so the Promise.all cannot reject.
    void Promise.all(
      result.superseded.map(async (oldCycle) => {
        // GitHub and Slack repairs are independent: neither gates the other,
        // so a GitHub outage can't leave live Slack buttons (or vice versa).
        const [gh, sl] = await Promise.allSettled([
          withRetry(() =>
            github.updateCheckRun(oldCycle, {
              conclusion: "neutral",
              output: {
                title: "Feature-Rec: superseded",
                summary: `Superseded by a newer PR head SHA: ${start.headSha}.`,
              },
            }),
          ),
          withRetry(() =>
            slack.finalize(oldCycle, "superseded", "A newer commit started a fresh validation cycle."),
          ),
        ]);
        if (gh.status === "rejected") {
          request.log.warn(
            { err: gh.reason, supersededCycleId: oldCycle.id },
            "best-effort check-run neutralize of superseded cycle failed",
          );
        }
        if (sl.status === "rejected") {
          request.log.warn(
            { err: sl.reason, supersededCycleId: oldCycle.id },
            "best-effort Slack finalize of superseded cycle failed",
          );
        }
      }),
    );

    // Advisory onboarding flag: inspect the explicit route and live membership
    // without initializing a route. The runner can then fail frontend-visible
    // PRs before rendering while auto-accepted PRs stay unaffected. Advisory
    // only: video-time resolution stays authoritative because routes and
    // membership can change mid-cycle, and it retains the missed-event fallback.
    //
    // Advisory means it must never fail the start: a Slack outage here would
    // otherwise strand the cycle as `analyzing` with no attemptId returned, and
    // every retry would exit as a duplicate. Unknown → omit the flag and let
    // video-time resolution decide.
    const onboarded = await tenantHasChannels().catch((err: unknown) => {
      request.log.warn({ err }, "advisory onboarding check failed; deferring to video-time resolution");
      return undefined;
    });

    // Takeover of a previously `failed` cycle: reuse its existing check run
    // (set it back to in_progress) instead of creating a second one, so a
    // re-run recovers a red check rather than exiting green over a red run.
    if (result.cycle.checkRunId) {
      await withRetry(() =>
        github.updateCheckRun(result.cycle, {
          status: "in_progress",
          output: {
            title: "Feature-Rec: analyzing",
            summary: "Re-running Feature-Rec after a previous failure.",
          },
        }),
      );
      return {
        cycleId: result.cycle.id,
        cycleKey,
        checkRunId: result.cycle.checkRunId,
        attemptId: result.attemptId,
        onboarded,
      };
    }

    // Fresh create: only the creator creates the check run, then attaches it atomically.
    // If GitHub rejects creation, release this attempt by marking it failed so
    // a same-head workflow rerun can take over instead of exiting as a duplicate.
    let checkRunId: number;
    try {
      checkRunId = await github.createCheckRun({ ...start, cycleKey });
    } catch (err) {
      await store.transitionRunnerStatus({
        cycleId: result.cycle.id,
        attemptId: result.attemptId,
        from: ["analyzing"],
        to: "failed",
      });
      throw err;
    }
    const statusAfterAttach = await store.attachCheckRun(result.cycle.id, checkRunId);
    if (statusAfterAttach === "superseded") {
      // A newer head superseded us between the transaction and the attach; its
      // neutralize loop saw check_run_id = null, so neutralize what we created.
      // Best-effort with retry: a transient PATCH failure must not 500 this
      // request — the runner's start already effectively lost (its results will
      // no-op as stale), and a retried /start would exit duplicate without
      // repairing. Now that the ID is attached, a later superseding head can
      // also see and neutralize it, so a dropped repair here isn't permanent.
      try {
        await withRetry(() =>
          github.updateCheckRun(
            { owner: start.owner, repo: start.repo, checkRunId },
            {
              conclusion: "neutral",
              output: {
                title: "Feature-Rec: superseded",
                summary: "Superseded by a newer PR head SHA before validation started.",
              },
            },
          ),
        );
      } catch (err) {
        request.log.warn(
          { err, cycleId: result.cycle.id, checkRunId },
          "best-effort neutralize of own superseded check run failed",
        );
      }
    }

    return {
      cycleId: result.cycle.id,
      cycleKey,
      checkRunId,
      attemptId: result.attemptId,
      onboarded,
    };
  });

  // Whether video delivery could resolve a channel now, without mutating the
  // route. A sole membership is usable through video delivery's missed-event
  // fallback, while join events remain the primary initialization path.
  async function tenantHasChannels(): Promise<boolean> {
    const { teamId } = await slack.botIdentity();
    const channelIds = await slack.listBotChannels();
    const selectedChannelId = await store.getSelectedChannelId(teamId);
    return selectedChannelId
      ? channelIds.includes(selectedChannelId)
      : channelIds.length === 1;
  }

  app.post("/api/runs/:cycleId/accepted", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const attemptId = bodyAttemptId(request.body);
    if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });
    const cycle = await store.transitionRunnerStatus({
      cycleId: param(request.params, "cycleId"),
      attemptId,
      from: ["analyzing"],
      to: "accepted",
    });
    if (!cycle) return reply.send({ ok: false, stale: true });
    await withRetry(() =>
      github.updateCheckRun(cycle, {
        conclusion: "success",
        output: {
          title: "Feature-Rec: accepted",
          summary: classifierSummary(request.body) || "No frontend-visible validation needed.",
        },
      }),
    );
    return { ok: true };
  });

  app.post("/api/runs/:cycleId/failed", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = request.body as { message?: string } | undefined;
    const attemptId = bodyAttemptId(request.body);
    if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });
    const cycle = await store.transitionRunnerStatus({
      cycleId: param(request.params, "cycleId"),
      attemptId,
      from: ["analyzing", "pending_validation"],
      to: "failed",
    });
    if (!cycle) return reply.send({ ok: false, stale: true });
    await withRetry(() =>
      github.updateCheckRun(cycle, {
        conclusion: "failure",
        output: {
          title: "Feature-Rec: failed",
          summary: body?.message ?? "Feature-Rec failed.",
        },
      }),
    );
    return { ok: true };
  });

  app.post(
    "/api/runs/:cycleId/video",
    { bodyLimit: VIDEO_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (!runnerAuthorized(env, request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const video = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);
      if (video.byteLength === 0) return reply.code(400).send({ error: "empty video body" });
      const attemptId = headerAttemptId(request.headers["x-feature-rec-attempt"]);
      if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });

      // Transition first (guards against stale/duplicate runners and gives
      // first-writer-wins idempotency), then run side effects.
      const cycle = await store.transitionRunnerStatus({
        cycleId: param(request.params, "cycleId"),
        attemptId,
        from: ["analyzing"],
        to: "pending_validation",
      });
      if (!cycle) return reply.send({ ok: false, stale: true });

      // Resolve the review channel before any side effect: with no channel
      // there is nowhere to post, so fail the cycle with an actionable
      // check-run message and tell the runner explicitly (settled: true) that
      // there is nothing left to report. The status guard on /failed remains
      // as defense-in-depth against races, not as the preservation mechanism.
      let resolved: {
        teamId: string;
        channelId: string;
        initializedRoute: boolean;
      };
      try {
        resolved = await resolveChannel(store, slack);
      } catch (err) {
        if (!(err instanceof ChannelResolutionError)) throw err;
        const failed = await store.transitionRunnerStatus({
          cycleId: cycle.id,
          attemptId,
          from: ["pending_validation"],
          to: "failed",
        });
        // Superseded while resolving: the superseder already neutralized the
        // check run — don't clobber its conclusion with a failure.
        if (!failed) return reply.send({ ok: false, stale: true });
        await withRetry(() =>
          github.updateCheckRun(cycle, {
            conclusion: "failure",
            output: {
              title: "Feature-Rec: no Slack review channel",
              summary: err.message,
            },
          }),
        );
        return reply
          .code(422)
          .send({ ok: false, error: "no_slack_channel", message: err.message, settled: true });
      }
      if (resolved.initializedRoute) {
        await greetJoinedChannel(resolved.teamId, resolved.channelId).catch((err: unknown) => {
          request.log.warn(
            { err, teamId: resolved.teamId, channelId: resolved.channelId },
            "missed-event fallback greeting failed",
          );
        });
      }
      await withRetry(() =>
        github.updateCheckRun(cycle, {
          status: "in_progress",
          output: {
            title: "Feature-Rec: pending validation",
            summary: "Frontend-visible change rendered and sent to Slack for validation.",
          },
        }),
      );

      const settings = await withRetry(() =>
        store.getChannelSettings(resolved.teamId, resolved.channelId),
      );

      await slack.uploadVideo(cycle, resolved.channelId, video);
      const message = await slack.postValidation(
        cycle,
        resolved.channelId,
        effectiveMention(settings),
      );
      // Persisting the same Slack coordinates is idempotent. Retry so a
      // transient DB failure does not leave a live validation message untracked.
      const statusAfter = await withRetry(() =>
        store.attachSlackMessage(cycle.id, message.channel, message.ts),
      );
      if (statusAfter === "superseded") {
        // Superseded after the transition but before the Slack post landed:
        // finalize the message we just posted so it can't strand in Slack.
        // Retried: nobody else will ever repair this message (the superseder's
        // cleanup already ran and saw no coordinates), and chat.update is idempotent.
        await withRetry(() =>
          slack.finalize(
            { ...cycle, slackChannelId: message.channel, slackMessageTs: message.ts },
            "superseded",
            "A newer commit started a fresh validation cycle.",
          ),
        );
      }
      return { ok: true, channel: message.channel, ts: message.ts };
    },
  );

  app.post("/api/slack/interactivity", async (request, reply) => {
    const rawBody = String(request.body ?? "");
    const signatureOk = verifySlackSignature({
      signingSecret: env.slackSigningSecret,
      timestamp: request.headers["x-slack-request-timestamp"] as string | undefined,
      signature: request.headers["x-slack-signature"] as string | undefined,
      rawBody,
    });
    if (!signatureOk) return reply.code(401).send({ error: "invalid slack signature" });

    const payloadParam = new URLSearchParams(rawBody).get("payload");
    if (!payloadParam) return reply.code(400).send({ error: "missing payload" });
    const payload = JSON.parse(payloadParam) as SlackPayload;
    if (payload.type === "block_actions") {
      void handleBlockAction(payload).catch((err) => app.log.error(err));
      return reply.send("");
    }
    if (payload.type === "view_submission") {
      const comment = extractModalComment(payload);
      if (!comment.trim()) {
        return reply.send({
          response_action: "errors",
          errors: { comment: "Please describe what needs to change." },
        });
      }
      void handleViewSubmission(payload, comment).catch((err) => app.log.error(err));
      return reply.send("");
    }

    return reply.send("");
  });

  app.post("/api/slack/events", async (request, reply) => {
    const signatureOk = verifySlackSignature({
      signingSecret: env.slackSigningSecret,
      timestamp: request.headers["x-slack-request-timestamp"] as string | undefined,
      signature: request.headers["x-slack-signature"] as string | undefined,
      rawBody: rawJsonBody(request.body),
    });
    if (!signatureOk) return reply.code(401).send({ error: "invalid slack signature" });

    const body = request.body as SlackEventEnvelope;
    if (body.type === "url_verification") return reply.send({ challenge: body.challenge ?? "" });
    if (body.type !== "event_callback") return reply.send({ ok: true });

    // Drop everything that isn't a bot join, without logging it:
    // membership events fire for every user entering a bot channel and their
    // payloads must never reach the logs.
    const event = body.event ?? {};
    const isJoin = event.type === "member_joined_channel";
    if (!isJoin || !event.user || !event.channel) return reply.send({ ok: true });
    const identity = await slack.botIdentity();
    if (event.user !== identity.userId) return reply.send({ ok: true });

    const teamId = body.team_id ?? identity.teamId;
    if (teamId !== identity.teamId) return reply.send({ ok: true });
    const channelId = event.channel;

    // The first observed join wins under the per-team route lock. Later joins
    // are deliberately silent and do not persist membership state.
    const initialized = await store.initializeTeamChannelRoute({ teamId, channelId });
    if (initialized.initializedRoute && (await isFirstEventDelivery(body.event_id))) {
      void greetJoinedChannel(teamId, channelId).catch((err) => app.log.error(err));
    }
    return reply.send({ ok: true });
  });

  // Route initialization is idempotent; the first greeting is not. Slack
  // retries therefore dedupe that side effect on the globally unique event ID.
  async function isFirstEventDelivery(eventId: string | undefined): Promise<boolean> {
    if (!eventId) return true;
    return store.recordProcessedInteraction(`slack-event:${eventId}`, "slack-event");
  }

  app.post("/api/slack/commands", async (request, reply) => {
    const rawBody = String(request.body ?? "");
    const signatureOk = verifySlackSignature({
      signingSecret: env.slackSigningSecret,
      timestamp: request.headers["x-slack-request-timestamp"] as string | undefined,
      signature: request.headers["x-slack-signature"] as string | undefined,
      rawBody,
    });
    if (!signatureOk) return reply.code(401).send({ error: "invalid slack signature" });

    const form = new URLSearchParams(rawBody);
    const teamId = form.get("team_id") ?? "";
    const channelId = form.get("channel_id") ?? "";
    const userId = form.get("user_id") ?? "";
    const responseUrl = form.get("response_url") ?? "";
    if (!teamId || !channelId || !userId || !responseUrl) {
      return reply.code(400).send({ error: "malformed command payload" });
    }

    const [subcommand, ...args] = (form.get("text") ?? "").trim().split(/\s+/).filter(Boolean);
    // Slack requires the command ack within three seconds. All command work,
    // including Slack API lookups and channel reconciliation, runs after this
    // empty 200 and delivers its result through the signed response_url.
    reply.send("");
    void handleCommand({ teamId, channelId, userId, responseUrl, subcommand, args });
    return reply;
  });

  async function handleCommand(input: {
    teamId: string;
    channelId: string;
    userId: string;
    responseUrl: string;
    subcommand: string | undefined;
    args: string[];
  }): Promise<void> {
    let text: string;
    try {
      const [identity, botChannelIds] = await Promise.all([
        slack.botIdentity(),
        slack.listBotChannels(),
      ]);
      if (identity.teamId !== input.teamId) {
        throw new CommandError("This command belongs to a different Slack workspace.");
      }
      const context = { ...input, botChannelIds };
      if (input.subcommand === "channel") {
        text = await channelCommand(context);
      } else if (input.subcommand === "mention") {
        text = await mentionCommand(context);
      } else if (input.subcommand === "approvers") {
        text = await approversCommand(context);
      } else if (input.subcommand === "status") {
        text = await statusCommand(context);
      } else {
        // Absent subcommand, `help`, and unknown subcommands share general help.
        text = GENERAL_HELP;
      }
    } catch (err) {
      if (err instanceof CommandError) {
        text = err.message;
      } else {
        app.log.error(
          { err, teamId: input.teamId, channelId: input.channelId },
          "Slack command failed",
        );
        text = COMMAND_FAILED;
      }
    }

    await slack.respondEphemeral(input.responseUrl, text).catch((err: unknown) => {
      app.log.warn(
        { err, teamId: input.teamId, channelId: input.channelId },
        "Slack command ephemeral reply failed",
      );
    });
  }

  type CommandContext = {
    teamId: string;
    channelId: string;
    userId: string;
    args: string[];
    botChannelIds: string[];
  };

  async function channelCommand(input: CommandContext): Promise<string> {
    if (input.args.length === 0) {
      const selectedChannelId = await store.getSelectedChannelId(input.teamId);
      if (!selectedChannelId) {
        return [`No review channel is selected.`, CHANNEL_HELP].join("\n");
      }
      const present = input.botChannelIds.includes(selectedChannelId);
      const settings = await store.getChannelSettings(input.teamId, selectedChannelId);
      const lines = [
        `Selected review channel: <#${selectedChannelId}> (${present ? "available" : "unavailable"}).`,
        describeChannelSettings(settings),
        CHANNEL_HELP,
      ];
      if (!present) lines.push(slackSelectedChannelUnavailableMessage(selectedChannelId));
      return lines.join("\n");
    }
    if (input.args.length !== 1) {
      throw new CommandError(CHANNEL_HELP);
    }
    const target = CHANNEL_MENTION_RE.exec(input.args[0]);
    if (!target) throw new CommandError(CHANNEL_HELP);
    const channelId = target[1];
    if (!input.botChannelIds.includes(channelId)) {
      throw new CommandError(`Invite @Feature-Rec to <#${channelId}>, then try again.`);
    }
    await store.selectTeamChannel({ teamId: input.teamId, channelId });
    const settings = await store.getChannelSettings(input.teamId, channelId);
    return [
      `Feature-Rec videos will now be sent to <#${channelId}>.`,
      describeChannelSettings(settings),
    ].join("\n");
  }

  function missingSelectedChannelMessage(botChannelIds: string[]): string {
    if (botChannelIds.length === 0) return SLACK_NO_CHANNEL_MESSAGE;
    if (botChannelIds.length > 1) return SLACK_MULTIPLE_CHANNELS_MESSAGE;
    return "No review channel is selected. Run `/feature-rec channel #channel-name` first.";
  }

  // Reads (status/help) only need a selected channel id. Writes still require
  // the bot to be present so membership checks and delivery stay coherent.
  async function requireSelectedChannelId(input: CommandContext): Promise<string> {
    const selectedChannelId = await store.getSelectedChannelId(input.teamId);
    if (!selectedChannelId) {
      throw new CommandError(missingSelectedChannelMessage(input.botChannelIds));
    }
    return selectedChannelId;
  }

  async function selectedCommandChannel(input: CommandContext): Promise<string> {
    const selectedChannelId = await requireSelectedChannelId(input);
    if (!input.botChannelIds.includes(selectedChannelId)) {
      throw new CommandError(slackSelectedChannelUnavailableMessage(selectedChannelId));
    }
    return selectedChannelId;
  }

  function assertGuardedSettingWrite(written: boolean): void {
    if (!written) {
      throw new CommandError(
        "The selected Feature-Rec channel changed while the command was running. Please try again.",
      );
    }
  }

  async function confirmChannelSettings(
    teamId: string,
    channelId: string,
    written: boolean,
    headline: string,
  ): Promise<string> {
    assertGuardedSettingWrite(written);
    const settings = await store.getChannelSettings(teamId, channelId);
    return [headline, describeChannelSettings(settings)].join("\n");
  }

  async function mentionCommand(input: CommandContext): Promise<string> {
    if (input.args.length === 0) {
      const channelId = await store.getSelectedChannelId(input.teamId);
      if (!channelId) {
        return [missingSelectedChannelMessage(input.botChannelIds), MENTION_HELP].join("\n");
      }
      const settings = await store.getChannelSettings(input.teamId, channelId);
      const lines = [`For <#${channelId}>:`, describeChannelSettings(settings), MENTION_HELP];
      if (!input.botChannelIds.includes(channelId)) {
        lines.push(slackSelectedChannelUnavailableMessage(channelId));
      }
      return lines.join("\n");
    }

    const channelId = await selectedCommandChannel(input);
    if (input.args.some((token) => token === "approvers" || token === "off")) {
      if (input.args.length !== 1) {
        throw new CommandError(
          "`approvers` and `off` must be used alone: `/feature-rec mention approvers` or `/feature-rec mention off`.",
        );
      }
      const mode = input.args[0] as "approvers" | "off";
      const written = await store.setSelectedChannelMentionSetting({
        teamId: input.teamId,
        expectedChannelId: channelId,
        mention: { mode },
        updatedBy: input.userId,
      });
      return confirmChannelSettings(
        input.teamId,
        channelId,
        written,
        mode === "off"
          ? `Validation requests in <#${channelId}> will not mention anyone.`
          : `Validation notifications in <#${channelId}> now follow approvers.`,
      );
    }

    if (
      input.args.length > 1 &&
      input.args.some((token) => token === "@channel" || token === "<!channel>")
    ) {
      throw new CommandError("Use @channel by itself: `/feature-rec mention @channel`.");
    }

    const targets = await resolveTargets(input.args, "mention");
    await validateTargetMembership(channelId, targets.concreteUserIds, "mentions");
    const audience = targets.rendered.join(" ");
    const written = await store.setSelectedChannelMentionSetting({
      teamId: input.teamId,
      expectedChannelId: channelId,
      mention: { mode: "custom", audience },
      updatedBy: input.userId,
    });
    return confirmChannelSettings(
      input.teamId,
      channelId,
      written,
      `Validation requests in <#${channelId}> will mention ${audience}.`,
    );
  }

  async function approversCommand(input: CommandContext): Promise<string> {
    if (input.args.length === 0) {
      const channelId = await store.getSelectedChannelId(input.teamId);
      if (!channelId) {
        return [missingSelectedChannelMessage(input.botChannelIds), APPROVERS_HELP].join("\n");
      }
      const settings = await store.getChannelSettings(input.teamId, channelId);
      const lines = [`For <#${channelId}>:`, describeChannelSettings(settings), APPROVERS_HELP];
      if (!input.botChannelIds.includes(channelId)) {
        lines.push(slackSelectedChannelUnavailableMessage(channelId));
      }
      return lines.join("\n");
    }

    const channelId = await selectedCommandChannel(input);
    if (input.args.some((token) => token === "@channel" || token === "<!channel>")) {
      if (input.args.length > 1) {
        throw new CommandError("Use @channel by itself: `/feature-rec approvers @channel`.");
      }
      const written = await store.setSelectedChannelApprovers({
        teamId: input.teamId,
        expectedChannelId: channelId,
        approvers: null,
        updatedBy: input.userId,
      });
      return confirmChannelSettings(
        input.teamId,
        channelId,
        written,
        `Everyone in <#${channelId}> can now approve.`,
      );
    }
    const targets = await resolveTargets(input.args, "approver");
    await validateTargetMembership(channelId, targets.concreteUserIds, "approvers");
    const written = await store.setSelectedChannelApprovers({
      teamId: input.teamId,
      expectedChannelId: channelId,
      approvers: targets.storedIds,
      updatedBy: input.userId,
    });
    return confirmChannelSettings(
      input.teamId,
      channelId,
      written,
      `Only ${joinList(targets.rendered)} can approve in <#${channelId}>.`,
    );
  }

  async function resolveTargets(
    tokens: string[],
    kind: "mention" | "approver",
  ): Promise<{ rendered: string[]; storedIds: string[]; concreteUserIds: string[] }> {
    const rendered = new Set<string>();
    const storedIds = new Set<string>();
    const concreteUserIds = new Set<string>();
    let usergroups: SlackUsergroup[] | null = null;
    for (const token of tokens) {
      if (kind === "mention" && (token === "@here" || token === "<!here>")) {
        rendered.add("<!here>");
        continue;
      }
      if (kind === "mention" && (token === "@channel" || token === "<!channel>")) {
        rendered.add("<!channel>");
        continue;
      }
      const user = USER_MENTION_RE.exec(token);
      if (user) {
        rendered.add(`<@${user[1]}>`);
        storedIds.add(user[1]);
        concreteUserIds.add(user[1]);
        continue;
      }
      const subteam = SUBTEAM_MENTION_RE.exec(token);
      usergroups ??= await slack.listUsergroups();
      const handle = token.replace(/^@/, "");
      const group = subteam
        ? usergroups.find((candidate) => candidate.id === subteam[1])
        : usergroups.find((candidate) => candidate.handle === handle);
      if (!group) {
        const help =
          kind === "mention"
            ? "Use @here, @channel, a usergroup handle, or user mentions."
            : "Use @channel, usergroup handles, or user mentions.";
        throw new CommandError(
          `Unknown ${kind === "mention" ? "mention target" : "approver"} ${token}. ${help}`,
        );
      }
      const members = await slack.listUsergroupMembers(group.id);
      if (members.length === 0) {
        throw new CommandError(`Usergroup @${group.handle} has no users and cannot be selected.`);
      }
      rendered.add(`<!subteam^${group.id}|@${group.handle}>`);
      storedIds.add(group.id);
      members.forEach((member) => concreteUserIds.add(member));
    }
    return {
      rendered: [...rendered],
      storedIds: [...storedIds],
      concreteUserIds: [...concreteUserIds],
    };
  }

  async function validateTargetMembership(
    channelId: string,
    userIds: string[],
    setting: "mentions" | "approvers",
  ): Promise<void> {
    if (userIds.length === 0) return;
    const channelMembers = new Set(await slack.listChannelMembers(channelId));
    const missing = userIds.filter((userId) => !channelMembers.has(userId));
    if (missing.length === 0) return;
    const visible = missing.slice(0, 5).map((userId) => `<@${userId}>`).join(", ");
    const remainder = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
    const verb = missing.length === 1 ? "is not a member" : "are not members";
    throw new CommandError(
      `Cannot update ${setting} for <#${channelId}>: ${visible}${remainder} ${verb} of that channel.`,
    );
  }

  async function statusCommand(input: CommandContext): Promise<string> {
    const selectedChannelId = await store.getSelectedChannelId(input.teamId);
    if (!selectedChannelId) {
      if (input.botChannelIds.length > 1) return SLACK_MULTIPLE_CHANNELS_MESSAGE;
      if (input.botChannelIds.length === 1) {
        return `Feature-Rec is already present in <#${input.botChannelIds[0]}>, but no review channel is selected. Run \`/feature-rec channel #channel-name\` to select it.`;
      }
      return SLACK_NO_CHANNEL_MESSAGE;
    }
    const settings = await store.getChannelSettings(input.teamId, selectedChannelId);
    const present = input.botChannelIds.includes(selectedChannelId);
    const lines = [
      `Selected review channel: <#${selectedChannelId}> (${present ? "available" : "unavailable"}).`,
      describeChannelSettings(settings),
    ];
    if (!present) {
      lines.push(slackSelectedChannelUnavailableMessage(selectedChannelId));
    }
    return lines.join("\n");
  }

  async function greetJoinedChannel(teamId: string, channelId: string): Promise<void> {
    const identity = await slack.botIdentity();
    if (identity.teamId !== teamId) return;
    const memberships = await slack.listBotChannels();
    const selectedChannelId = await store.getSelectedChannelId(teamId);
    if (selectedChannelId !== channelId || !memberships.includes(channelId)) return;
    await slack.postMessage(channelId, SLACK_GREETING_ACTIVE);
  }

  // Approval authorization comes from the channel's settings at click time:
  // no list means everyone in the channel may approve; otherwise expand the
  // stored usergroups/users and answer unauthorized clicks ephemerally —
  // never drop them silently.
  async function approvalGate(
    payload: SlackPayload,
    cycle: CycleRecord,
    responseUrl: string | undefined,
  ): Promise<boolean> {
    const teamId = payload.team?.id ?? (await slack.botIdentity()).teamId;
    const settings = cycle.slackChannelId
      ? await store.getChannelSettings(teamId, cycle.slackChannelId)
      : DEFAULT_CHANNEL_SETTINGS;
    const approvers = settings.approvers;
    if (await slack.isApprover(approvers, payload.user?.id)) return true;
    app.log.warn({ cycleId: cycle.id, slackUserId: payload.user?.id }, "unauthorized Slack approver");
    if (responseUrl && approvers) {
      // Best-effort: a modal can outlive its stashed response_url (30 min),
      // and a dead URL must not turn the rejection into a handler error.
      await slack
        .respondEphemeral(
          responseUrl,
          `Only ${formatApproverList(approvers)} can approve.`,
        )
        .catch((err: unknown) =>
          app.log.warn({ err, cycleId: cycle.id }, "unauthorized-approver ephemeral reply failed"),
        );
    }
    return false;
  }

  async function handleBlockAction(payload: SlackPayload): Promise<void> {
    const action = payload.actions?.[0];
    const value = SlackApprovalPayloadSchema.parse(JSON.parse(action?.value ?? "{}"));
    const interactionId = `block:${payload.trigger_id ?? ""}:${action?.action_ts ?? ""}:${value.action}`;

    const cycle = await store.getCycle(value.cycleId);
    if (!cycle) return;
    if (!(await approvalGate(payload, cycle, payload.response_url))) return;
    if (!(await store.recordProcessedInteraction(interactionId, value.cycleId))) return;

    if (value.action === "accept") {
      // Transition-first: two distinct clicks both pass dedupe, so the status
      // guard is what serializes them. Stop on null (stale or lost the race).
      const accepted = await store.transitionSlackStatus({
        cycleId: cycle.id,
        from: ["pending_validation"],
        to: "accepted",
      });
      if (!accepted) return;
      // No withRetry around accept: the comment POST inside is not idempotent;
      // the check-run PATCH retries internally (see GitHubClient.accept).
      // GitHub and Slack effects run independently: the DB already settled the
      // cycle, so a GitHub failure must not skip the Slack finalize (live
      // buttons on a decided cycle), nor vice versa.
      await settleSideEffects(accepted.id, [
        ["github accept", github.accept(accepted)],
        ["slack finalize", withRetry(() => slack.finalize(accepted, "accepted", "Validation passed."))],
      ]);
      return;
    }

    if (payload.trigger_id) {
      await slack.openRequestChangesModal(payload.trigger_id, cycle, payload.response_url);
    }
  }

  async function handleViewSubmission(payload: SlackPayload, comment: string): Promise<void> {
    const meta = JSON.parse(payload.view?.private_metadata ?? "{}") as {
      cycleId?: string;
      headSha?: string;
      responseUrl?: string;
    };
    const cycleId = meta.cycleId ?? "";
    const interactionId = `view:${payload.view?.id ?? ""}:${payload.view?.hash ?? ""}`;
    const cycle = await store.getCycle(cycleId);
    if (!cycle) return;
    if (!(await approvalGate(payload, cycle, meta.responseUrl))) return;
    if (!(await store.recordProcessedInteraction(interactionId, cycleId))) return;

    const rejected = await store.transitionSlackStatus({
      cycleId: cycle.id,
      from: ["pending_validation"],
      to: "rejected",
    });
    if (!rejected) return;
    // No withRetry around reject: comment POST is not idempotent; the check-run
    // PATCH retries internally (see GitHubClient.reject). GitHub and Slack
    // effects run independently (see accept path for rationale).
    await settleSideEffects(rejected.id, [
      ["github reject", github.reject(rejected, comment.trim())],
      ["slack finalize", withRetry(() => slack.finalize(rejected, "rejected", comment.trim()))],
    ]);
  }

  // Runs post-commit side effects independently and logs each failure without
  // letting one channel's outage suppress the other's repair.
  async function settleSideEffects(cycleId: string, effects: Array<[string, Promise<unknown>]>): Promise<void> {
    const results = await Promise.allSettled(effects.map(([, p]) => p));
    results.forEach((res, i) => {
      if (res.status === "rejected") {
        app.log.warn({ err: res.reason, cycleId, effect: effects[i][0] }, "post-commit side effect failed");
      }
    });
  }

  return app;
}

function extractModalComment(payload: SlackPayload): string {
  const values = payload.view?.state?.values ?? {};
  return values.comment?.value?.value ?? "";
}
