import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { FeatureRecConfigSchema } from "@feature-rec/core";
import type { ReviewCycleStatus, RunStartRequest } from "@feature-rec/core";
import type { CycleRecord, CycleStore } from "../storage";

function now(): string {
  return new Date().toISOString();
}

function isProcessedInteractionDuplicate(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return message.includes("UNIQUE constraint failed: processed_interactions.id");
}

function rowToCycle(row: Record<string, unknown>): CycleRecord {
  return {
    id: String(row.id),
    cycleKey: String(row.cycle_key),
    owner: String(row.owner),
    repo: String(row.repo),
    prNumber: Number(row.pr_number),
    headSha: String(row.head_sha),
    configHash: String(row.config_hash),
    status: String(row.status) as ReviewCycleStatus,
    checkRunId: row.check_run_id === null ? null : Number(row.check_run_id),
    slackChannelId: row.slack_channel_id === null ? null : String(row.slack_channel_id),
    slackMessageTs: row.slack_message_ts === null ? null : String(row.slack_message_ts),
    prAuthor: String(row.pr_author ?? ""),
    prTitle: String(row.pr_title ?? ""),
    config: FeatureRecConfigSchema.parse(JSON.parse(String(row.config_json))),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteCycleStore implements CycleStore {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      create table if not exists review_cycles (
        id text primary key,
        cycle_key text not null unique,
        owner text not null,
        repo text not null,
        pr_number integer not null,
        pr_author text not null default '',
        pr_title text not null default '',
        config_json text not null,
        head_sha text not null,
        config_hash text not null,
        status text not null,
        check_run_id integer,
        slack_channel_id text,
        slack_message_ts text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists processed_interactions (
        id text primary key,
        cycle_id text not null,
        created_at text not null
      );
    `);
  }

  async upsertCycle(input: RunStartRequest & { cycleKey: string }): Promise<CycleRecord> {
    const existing = await this.getCycleByKey(input.cycleKey);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const t = now();
    this.#db
      .prepare(
        `insert into review_cycles (
          id, cycle_key, owner, repo, pr_number, pr_author, pr_title, config_json, head_sha,
          config_hash, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzing', ?, ?)`,
      )
      .run(
        id,
        input.cycleKey,
        input.owner,
        input.repo,
        input.prNumber,
        input.prAuthor,
        input.prTitle,
        JSON.stringify(input.config),
        input.headSha,
        input.configHash,
        t,
        t,
      );
    return (await this.getCycle(id)) ?? (() => {
      throw new Error("Failed to create review cycle");
    })();
  }

  async getCycle(id: string): Promise<CycleRecord | null> {
    const row = this.#db.prepare("select * from review_cycles where id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCycle(row) : null;
  }

  async getCycleByKey(cycleKey: string): Promise<CycleRecord | null> {
    const row = this.#db.prepare("select * from review_cycles where cycle_key = ?").get(cycleKey) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCycle(row) : null;
  }

  async markSupersededForPr(input: {
    owner: string;
    repo: string;
    prNumber: number;
    exceptHeadSha: string;
  }): Promise<CycleRecord[]> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db
        .prepare(
          `select * from review_cycles
           where owner = ? and repo = ? and pr_number = ? and head_sha != ?
           and status in ('analyzing', 'pending_validation')`,
        )
        .all(input.owner, input.repo, input.prNumber, input.exceptHeadSha) as Record<string, unknown>[];
      const t = now();
      this.#db
        .prepare(
          `update review_cycles set status = 'superseded', updated_at = ?
           where owner = ? and repo = ? and pr_number = ? and head_sha != ?
           and status in ('analyzing', 'pending_validation')`,
        )
        .run(t, input.owner, input.repo, input.prNumber, input.exceptHeadSha);
      this.#db.exec("COMMIT");
      return rows.map(rowToCycle);
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  async updateCheckRun(id: string, checkRunId: number): Promise<void> {
    this.#db
      .prepare("update review_cycles set check_run_id = ?, updated_at = ? where id = ?")
      .run(checkRunId, now(), id);
  }

  async updateStatus(id: string, status: ReviewCycleStatus): Promise<void> {
    this.#db
      .prepare("update review_cycles set status = ?, updated_at = ? where id = ?")
      .run(status, now(), id);
  }

  async updateSlackMessage(id: string, channelId: string, messageTs: string): Promise<void> {
    this.#db
      .prepare(
        "update review_cycles set slack_channel_id = ?, slack_message_ts = ?, updated_at = ? where id = ?",
      )
      .run(channelId, messageTs, now(), id);
  }

  async recordProcessedInteraction(id: string, cycleId: string): Promise<boolean> {
    try {
      this.#db
        .prepare("insert into processed_interactions (id, cycle_id, created_at) values (?, ?, ?)")
        .run(id, cycleId, now());
      return true;
    } catch (err) {
      if (!isProcessedInteractionDuplicate(err)) throw err;
      return false;
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
