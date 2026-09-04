import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("tenants")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("enabled", "boolean", (col) => col.notNull().defaultTo(false))
    .execute();

  await db.schema
    .createTable("slack_workspaces")
    .addColumn("team_id", "text", (col) => col.primaryKey())
    .addColumn("tenant_id", "uuid", (col) => col.notNull())
    .addColumn("bot_user_id", "text", (col) => col.notNull())
    .addColumn("bot_token_ciphertext", "text", (col) => col.notNull())
    .addColumn("selected_channel_id", "text")
    .addForeignKeyConstraint(
      "slack_workspaces_tenant_id_fkey",
      ["tenant_id"],
      "tenants",
      ["id"],
    )
    .addUniqueConstraint("slack_workspaces_tenant_id_key", ["tenant_id"])
    .execute();

  await db.schema
    .createTable("github_installations")
    .addColumn("installation_id", "bigint", (col) => col.primaryKey())
    .addColumn("tenant_id", "uuid", (col) => col.notNull())
    .addColumn("github_account_id", "bigint", (col) => col.notNull())
    .addForeignKeyConstraint(
      "github_installations_tenant_id_fkey",
      ["tenant_id"],
      "tenants",
      ["id"],
    )
    .addUniqueConstraint("github_installations_tenant_id_key", ["tenant_id"])
    .addUniqueConstraint("github_installations_github_account_id_key", ["github_account_id"])
    .execute();

  await db.schema
    .alterTable("review_cycles")
    .addColumn("tenant_id", "uuid")
    .addColumn("repository_id", "bigint")
    .execute();
  await db.schema
    .alterTable("review_cycles")
    .addForeignKeyConstraint(
      "review_cycles_tenant_id_fkey",
      ["tenant_id"],
      "tenants",
      ["id"],
    )
    .execute();
  await db.schema.alterTable("review_cycles").alterColumn("owner", (col) => col.dropNotNull()).execute();
  await db.schema.alterTable("review_cycles").alterColumn("repo", (col) => col.dropNotNull()).execute();
  await db.schema
    .createIndex("review_cycles_tenant_repo_pr_idx")
    .on("review_cycles")
    .columns(["tenant_id", "repository_id", "pr_number"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const legacyNulls = await sql<{ count: string }>`
    select count(*)::text as count
    from review_cycles
    where owner is null or repo is null
  `.execute(db);
  if (legacyNulls.rows[0]?.count !== "0") {
    throw new Error(
      "Cannot roll back 0008_multitenant_expand: review_cycles.owner/repo contain null values",
    );
  }

  await db.schema.alterTable("review_cycles").alterColumn("owner", (col) => col.setNotNull()).execute();
  await db.schema.alterTable("review_cycles").alterColumn("repo", (col) => col.setNotNull()).execute();
  await db.schema.dropIndex("review_cycles_tenant_repo_pr_idx").ifExists().execute();
  await db.schema.alterTable("review_cycles").dropColumn("repository_id").dropColumn("tenant_id").execute();
  await db.schema.dropTable("github_installations").execute();
  await db.schema.dropTable("slack_workspaces").execute();
  await db.schema.dropTable("tenants").execute();
}
