import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "./schema";

export async function readSelectedChannel(db: Kysely<DB>, teamId: string): Promise<string | null> {
  // Both lookups use the team primary key and share one statement snapshot.
  const result = await sql<{ selected_channel_id: string | null }>`
    select coalesce(
      (select selected_channel_id from slack_workspaces where team_id = ${teamId}),
      (select selected_channel_id from team_channel_routes where team_id = ${teamId})
    ) as selected_channel_id
  `.execute(db);
  return result.rows[0].selected_channel_id;
}

// Caller must hold lockTeamChannelRoute so readers/settings writers observe the same selection.
export async function writeSelectedChannel(trx: Transaction<DB>, teamId: string, channelId: string): Promise<void> {
  await trx.insertInto("team_channel_routes")
    .values({ team_id: teamId, selected_channel_id: channelId })
    .onConflict((oc) => oc.column("team_id").doUpdateSet({ selected_channel_id: channelId }))
    .execute();
  await trx.updateTable("slack_workspaces").set({ selected_channel_id: channelId })
    .where("team_id", "=", teamId).execute();
}
