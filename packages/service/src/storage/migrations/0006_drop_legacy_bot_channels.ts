import type { Kysely } from "kysely";

// The explicit team route has been authoritative since migration 0005. Dropping
// this legacy membership snapshot ends support for queue-based binary rollback.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("bot_channels").execute();
}

// Migration-tool symmetry only: membership history cannot be reconstructed.
// Operational rollback requires the database snapshot taken before `up` ran.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("bot_channels")
    .addColumn("team_id", "text", (col) => col.notNull())
    .addColumn("channel_id", "text", (col) => col.notNull())
    .addColumn("joined_at", "timestamptz")
    .addColumn("first_seen_at", "timestamptz", (col) => col.notNull())
    .addColumn("last_seen_at", "timestamptz", (col) => col.notNull())
    .addColumn("left_at", "timestamptz")
    .addColumn("last_left_at", "timestamptz")
    .addPrimaryKeyConstraint("bot_channels_pkey", ["team_id", "channel_id"])
    .execute();
}
