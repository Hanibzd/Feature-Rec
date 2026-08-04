import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table channel_settings rename column mention to mention_audience`.execute(db);
  await sql`
    alter table channel_settings
    add column mention_mode text not null default 'approvers'
  `.execute(db);
  // Intentionally lossy: every existing channel enters follow-approvers mode.
  await sql`update channel_settings set mention_audience = null`.execute(db);
  await sql`
    alter table channel_settings
    add constraint channel_settings_mention_mode_check
    check (mention_mode in ('approvers', 'custom', 'off'))
  `.execute(db);
  await sql`
    alter table channel_settings
    add constraint channel_settings_mention_audience_check
    check (
      (mention_mode = 'custom' and mention_audience is not null and mention_audience <> '')
      or
      (mention_mode in ('approvers', 'off') and mention_audience is null)
    )
  `.execute(db);
}

// Restores the old column name and drops mode. Custom mention values are not
// reconstructed; operational rollback needs the pre-migration snapshot.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table channel_settings
    drop constraint channel_settings_mention_audience_check
  `.execute(db);
  await sql`
    alter table channel_settings
    drop constraint channel_settings_mention_mode_check
  `.execute(db);
  await sql`alter table channel_settings drop column mention_mode`.execute(db);
  await sql`alter table channel_settings rename column mention_audience to mention`.execute(db);
}
