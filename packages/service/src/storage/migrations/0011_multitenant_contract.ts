import type { Kysely } from "kysely";

// Deploy D contract. Deploy C stopped every read and write of these legacy
// objects, so its still-serving process is unaffected while this runs. The
// historical repository names, config payloads and routes are deleted, so
// pre-cutover binaries are no longer rollback-compatible: 0008's down() refuses
// whenever a cycle exists, and recovering deploy A means restoring the
// pre-cutover backup.
//
// Following the rollback runbook, destructive drops use `if exists`: an object
// already removed by hand cannot fail deploy D's startup.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("team_channel_routes").ifExists().execute();
  await db.schema
    .alterTable("review_cycles")
    .dropColumn("owner", (col) => col.ifExists())
    .dropColumn("repo", (col) => col.ifExists())
    .dropColumn("config_hash", (col) => col.ifExists())
    .dropColumn("config_json", (col) => col.ifExists())
    .execute();
}

// Recreates only the empty compatibility shapes. Deploy C neither reads nor
// writes them, so D-to-C needs no historical values; never fabricate them.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("team_channel_routes")
    .addColumn("team_id", "text", (col) => col.primaryKey())
    .addColumn("selected_channel_id", "text", (col) => col.notNull())
    .execute();
  await db.schema
    .alterTable("review_cycles")
    .addColumn("owner", "text")
    .addColumn("repo", "text")
    .addColumn("config_json", "text")
    .addColumn("config_hash", "text")
    .execute();
}
