import crypto from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { Selectable, Transaction } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { z } from "zod";
import type { ReviewCycleStatus, RunStartRequest } from "@feature-rec/core";
import {
  DEFAULT_CHANNEL_SETTINGS,
  type ChannelSettings,
  type CycleRecord,
  type CycleStore,
  type MentionSetting,
  type StartCycleResult,
} from "../storage";
import type { DB, ReviewCyclesTable } from "./schema";
import { migrationProvider } from "./migrations";

const ApproverIdsSchema = z.array(z.string());
const MentionModeSchema = z.enum(["approvers", "custom", "off"]);

type ChannelSettingsColumns = {
  mention?: MentionSetting;
  approvers?: string | null;
};

function now(): string {
  return new Date().toISOString();
}

function rowToCycle(row: Selectable<ReviewCyclesTable>): CycleRecord {
  if (row.owner === null || row.repo === null) {
    throw new Error(
      `Review cycle ${row.id} has no repository coordinates required by the compatibility runtime`,
    );
  }
  return {
    id: row.id,
    cycleKey: row.cycle_key,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    status: row.status,
    // int8 comes back as a string from `pg`; GitHub IDs stay well below 2^53.
    checkRunId: row.check_run_id === null ? null : Number(row.check_run_id),
    slackChannelId: row.slack_channel_id,
    slackMessageTs: row.slack_message_ts,
    prAuthor: row.pr_author,
    prTitle: row.pr_title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresCycleStore implements CycleStore {
  #db: Kysely<DB>;

  constructor(connectionString: string) {
    this.#db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
    });
  }

  async init(): Promise<void> {
    const migrator = new Migrator({ db: this.#db, provider: migrationProvider });
    const { error } = await migrator.migrateToLatest();
    if (error) {
      throw error instanceof Error ? error : new Error(`Migration failed: ${String(error)}`);
    }
  }

  async hasSlackWorkspaces(): Promise<boolean> {
    const row = await this.#db.selectFrom("slack_workspaces").select("team_id").limit(1).executeTakeFirst();
    return row !== undefined;
  }

  async startCycle(input: RunStartRequest & { cycleKey: string }): Promise<StartCycleResult> {
    const lockKey = `${input.owner}/${input.repo}#${input.prNumber}`;
    return this.#db.transaction().execute(async (trx) => {
      // Per-PR serialization: 64-bit advisory lock held until commit. Bound
      // value (not string-concatenated SQL); hashtextextended keeps 64 bits.
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);

      const id = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      const t = now();

      const insertedRow = await trx
        .insertInto("review_cycles")
        .values({
          id,
          cycle_key: input.cycleKey,
          owner: input.owner,
          repo: input.repo,
          pr_number: input.prNumber,
          pr_author: input.prAuthor,
          pr_title: input.prTitle,
          head_sha: input.headSha,
          status: "analyzing",
          attempt_id: attemptId,
          created_at: t,
          updated_at: t,
        })
        .onConflict((oc) => oc.column("cycle_key").doNothing())
        .returningAll()
        .executeTakeFirst();

      // Conflict on cycle_key: a cycle already exists for this exact head.
      if (!insertedRow) {
        const existing = await trx
          .selectFrom("review_cycles")
          .selectAll()
          .where("cycle_key", "=", input.cycleKey)
          .executeTakeFirstOrThrow();

        // Takeover from `failed`: failed is terminal, so there is provably no
        // live owner to race (any zombie twitch is fenced by its stale token).
        // Re-issue ownership in this same locked transaction — mint a fresh
        // attempt token (reusing the one minted above, which never persisted)
        // and reset to `analyzing` — rather than exiting as a duplicate. Run no
        // supersession: this re-runs the same head and must not displace a
        // newer active head. The handler reuses the existing check_run_id.
        if (existing.status === "failed") {
          const revived = await trx
            .updateTable("review_cycles")
            .set({ status: "analyzing", attempt_id: attemptId, updated_at: now() })
            .where("id", "=", existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          return { cycle: rowToCycle(revived), superseded: [], created: true, attemptId };
        }

        // Any other status is a clean no-op exit — a stale start must never
        // displace the currently active cycle.
        return { cycle: rowToCycle(existing), superseded: [], created: false, attemptId: null };
      }

      const supersededRows = await trx
        .updateTable("review_cycles")
        .set({ status: "superseded", updated_at: now() })
        .where("owner", "=", input.owner)
        .where("repo", "=", input.repo)
        .where("pr_number", "=", input.prNumber)
        .where("head_sha", "!=", input.headSha)
        .where("status", "in", ["analyzing", "pending_validation"])
        .returningAll()
        .execute();

      return {
        cycle: rowToCycle(insertedRow),
        superseded: supersededRows.map(rowToCycle),
        created: true,
        attemptId,
      };
    });
  }

  async getCycle(id: string): Promise<CycleRecord | null> {
    const row = await this.#db
      .selectFrom("review_cycles")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToCycle(row) : null;
  }

  async getCycleByKey(cycleKey: string): Promise<CycleRecord | null> {
    const row = await this.#db
      .selectFrom("review_cycles")
      .selectAll()
      .where("cycle_key", "=", cycleKey)
      .executeTakeFirst();
    return row ? rowToCycle(row) : null;
  }

  async attachCheckRun(cycleId: string, checkRunId: number): Promise<ReviewCycleStatus> {
    const row = await this.#db
      .updateTable("review_cycles")
      .set({ check_run_id: checkRunId, updated_at: now() })
      .where("id", "=", cycleId)
      .returning("status")
      .executeTakeFirstOrThrow();
    return row.status;
  }

  // Runner transitions carry an ownership token; Slack transitions don't. Both
  // funnel through one guarded UPDATE so the SQL lives in a single place.
  async #transitionStatus(input: {
    cycleId: string;
    attemptId?: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null> {
    let query = this.#db
      .updateTable("review_cycles")
      .set({ status: input.to, updated_at: now() })
      .where("id", "=", input.cycleId)
      .where("status", "in", input.from);
    if (input.attemptId !== undefined) {
      query = query.where("attempt_id", "=", input.attemptId);
    }
    const row = await query.returningAll().executeTakeFirst();
    return row ? rowToCycle(row) : null;
  }

  transitionRunnerStatus(input: {
    cycleId: string;
    attemptId: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null> {
    return this.#transitionStatus(input);
  }

  transitionSlackStatus(input: {
    cycleId: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null> {
    return this.#transitionStatus(input);
  }

  async attachSlackMessage(
    cycleId: string,
    channelId: string,
    messageTs: string,
  ): Promise<ReviewCycleStatus> {
    // Write channel/ts only while still pending_validation; return current status.
    const written = await this.#db
      .updateTable("review_cycles")
      .set({ slack_channel_id: channelId, slack_message_ts: messageTs, updated_at: now() })
      .where("id", "=", cycleId)
      .where("status", "=", "pending_validation")
      .returning("status")
      .executeTakeFirst();
    if (written) return written.status;

    const current = await this.#db
      .selectFrom("review_cycles")
      .select("status")
      .where("id", "=", cycleId)
      .executeTakeFirstOrThrow();
    return current.status;
  }

  async recordProcessedInteraction(id: string, cycleId: string): Promise<boolean> {
    const result = await this.#db
      .insertInto("processed_interactions")
      .values({ id, cycle_id: cycleId, created_at: now() })
      .onConflict((oc) => oc.column("id").doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async getSelectedChannelId(teamId: string): Promise<string | null> {
    const row = await this.#db
      .selectFrom("team_channel_routes as route")
      .fullJoin("slack_workspaces as workspace", "workspace.team_id", "route.team_id")
      .select((eb) =>
        eb.fn
          .coalesce("workspace.selected_channel_id", "route.selected_channel_id")
          .as("selected_channel_id"),
      )
      .where((eb) =>
        eb.or([eb("route.team_id", "=", teamId), eb("workspace.team_id", "=", teamId)]),
      )
      .executeTakeFirst();
    return row?.selected_channel_id ?? null;
  }

  async initializeTeamChannelRoute(input: {
    teamId: string;
    channelId: string;
  }): Promise<{ initializedRoute: boolean }> {
    return this.#db.transaction().execute(async (trx) => {
      const lockKey = `team-route:${input.teamId}`;
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
      const result = await trx
        .insertInto("team_channel_routes")
        .values({ team_id: input.teamId, selected_channel_id: input.channelId })
        .onConflict((oc) => oc.column("team_id").doNothing())
        .executeTakeFirst();
      const route = await trx
        .selectFrom("team_channel_routes")
        .select("selected_channel_id")
        .where("team_id", "=", input.teamId)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("slack_workspaces")
        .set({ selected_channel_id: route.selected_channel_id })
        .where("team_id", "=", input.teamId)
        .execute();
      return { initializedRoute: (result.numInsertedOrUpdatedRows ?? 0n) > 0n };
    });
  }

  async selectTeamChannel(input: {
    teamId: string;
    channelId: string;
  }): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const lockKey = `team-route:${input.teamId}`;
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
      await trx
        .insertInto("team_channel_routes")
        .values({
          team_id: input.teamId,
          selected_channel_id: input.channelId,
        })
        .onConflict((oc) =>
          oc.column("team_id").doUpdateSet({ selected_channel_id: input.channelId }),
        )
        .execute();
      await trx
        .updateTable("slack_workspaces")
        .set({ selected_channel_id: input.channelId })
        .where("team_id", "=", input.teamId)
        .execute();
    });
  }

  async getChannelSettings(teamId: string, channelId: string): Promise<ChannelSettings> {
    const row = await this.#db
      .selectFrom("channel_settings")
      .selectAll()
      .where("team_id", "=", teamId)
      .where("channel_id", "=", channelId)
      .executeTakeFirst();
    if (!row) {
      return {
        mention: { ...DEFAULT_CHANNEL_SETTINGS.mention },
        approvers: DEFAULT_CHANNEL_SETTINGS.approvers,
      };
    }
    let approvers: string[] | null = null;
    if (row.approvers !== null) {
      try {
        approvers = ApproverIdsSchema.parse(JSON.parse(row.approvers));
      } catch (err) {
        throw new Error(
          `channel_settings.approvers for ${teamId}/${channelId} is not a JSON string array: ${String(err)}`,
        );
      }
    }
    const parsedMode = MentionModeSchema.safeParse(row.mention_mode);
    if (!parsedMode.success) {
      throw new Error(
        `channel_settings.mention_mode for ${teamId}/${channelId} is invalid: ${row.mention_mode}`,
      );
    }
    let mention: MentionSetting;
    if (parsedMode.data === "custom") {
      if (row.mention_audience === null || row.mention_audience === "") {
        throw new Error(
          `channel_settings.mention_audience for ${teamId}/${channelId} is missing for custom mode`,
        );
      }
      mention = { mode: "custom", audience: row.mention_audience };
    } else if (row.mention_audience !== null) {
      throw new Error(
        `channel_settings.mention_audience for ${teamId}/${channelId} must be null in ${parsedMode.data} mode`,
      );
    } else {
      mention = { mode: parsedMode.data };
    }
    return { mention, approvers };
  }

  async #upsertChannelSettings(
    input: {
      teamId: string;
      channelId: string;
      updatedBy: string;
      set: ChannelSettingsColumns;
    },
    db: Kysely<DB> | Transaction<DB> = this.#db,
  ): Promise<void> {
    const t = now();
    const mention = input.set.mention ?? DEFAULT_CHANNEL_SETTINGS.mention;
    const mention_mode = mention.mode;
    const mention_audience = mention.mode === "custom" ? mention.audience : null;
    await db
      .insertInto("channel_settings")
      .values({
        team_id: input.teamId,
        channel_id: input.channelId,
        mention_mode,
        mention_audience,
        approvers: input.set.approvers ?? null,
        updated_by: input.updatedBy,
        updated_at: t,
      })
      .onConflict((oc) =>
        oc.columns(["team_id", "channel_id"]).doUpdateSet({
          ...(input.set.mention === undefined
            ? {}
            : {
                mention_mode,
                mention_audience,
              }),
          ...(input.set.approvers === undefined ? {} : { approvers: input.set.approvers }),
          updated_by: input.updatedBy,
          updated_at: t,
        }),
      )
      .execute();
  }

  async setSelectedChannelMentionSetting(input: {
    teamId: string;
    expectedChannelId: string;
    mention: MentionSetting;
    updatedBy: string;
  }): Promise<boolean> {
    return this.#updateSelectedChannelSettings({
      teamId: input.teamId,
      expectedChannelId: input.expectedChannelId,
      updatedBy: input.updatedBy,
      set: { mention: input.mention },
    });
  }

  async setSelectedChannelApprovers(input: {
    teamId: string;
    expectedChannelId: string;
    approvers: string[] | null;
    updatedBy: string;
  }): Promise<boolean> {
    // An empty list means "everyone", same as null — store the canonical form.
    const approvers = input.approvers?.length ? JSON.stringify(input.approvers) : null;
    return this.#updateSelectedChannelSettings({
      teamId: input.teamId,
      expectedChannelId: input.expectedChannelId,
      updatedBy: input.updatedBy,
      set: { approvers },
    });
  }

  async #updateSelectedChannelSettings(input: {
    teamId: string;
    expectedChannelId: string;
    updatedBy: string;
    set: ChannelSettingsColumns;
  }): Promise<boolean> {
    return this.#db.transaction().execute(async (trx) => {
      const lockKey = `team-route:${input.teamId}`;
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
      const route = await trx
        .selectFrom("team_channel_routes as legacy")
        .fullJoin("slack_workspaces as workspace", "workspace.team_id", "legacy.team_id")
        .select((eb) =>
          eb.fn
            .coalesce("workspace.selected_channel_id", "legacy.selected_channel_id")
            .as("selected_channel_id"),
        )
        .where((eb) =>
          eb.or([
            eb("legacy.team_id", "=", input.teamId),
            eb("workspace.team_id", "=", input.teamId),
          ]),
        )
        .executeTakeFirst();
      if (route?.selected_channel_id !== input.expectedChannelId) return false;
      await this.#upsertChannelSettings(
        {
          teamId: input.teamId,
          channelId: input.expectedChannelId,
          updatedBy: input.updatedBy,
          set: input.set,
        },
        trx,
      );
      return true;
    });
  }

  async close(): Promise<void> {
    await this.#db.destroy();
  }
}
