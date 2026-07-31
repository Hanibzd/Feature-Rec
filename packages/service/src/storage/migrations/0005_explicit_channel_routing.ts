import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("team_channel_routes")
    .addColumn("team_id", "text", (col) => col.primaryKey())
    .addColumn("selected_channel_id", "text", (col) => col.notNull())
    .execute();

  // Preserve the channel that the queue-based runtime considered active at
  // deployment time. Settings stay keyed by team/channel and need no rewrite.
  await sql`
    insert into team_channel_routes (team_id, selected_channel_id)
    select distinct on (team_id)
      team_id,
      channel_id
    from bot_channels
    where left_at is null
    order by
      team_id,
      coalesce(joined_at, first_seen_at),
      channel_id
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("team_channel_routes").execute();
}
