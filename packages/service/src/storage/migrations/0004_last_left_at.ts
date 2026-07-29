import type { Kysely } from "kysely";
import { sql } from "kysely";

// Keep the previous membership generation's leave boundary after left_at is
// cleared on rejoin. Delayed join events can then be assigned to the correct
// generation instead of restoring an old queue position.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("bot_channels")
    .addColumn("last_left_at", "timestamptz")
    .execute();
  await sql`
    update bot_channels
    set last_left_at = left_at
    where left_at is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("bot_channels").dropColumn("last_left_at").execute();
}
