import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "./schema";

export async function lockTeamChannelRoute(trx: Transaction<DB>, teamId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`team-route:${teamId}`}, 0))`.execute(trx);
}

export async function lockTenantProvisioning(trx: Transaction<DB>): Promise<void> {
  // Serialize ownership checks even when the integration rows do not exist yet.
  await sql`select pg_advisory_xact_lock(hashtextextended('tenant-integration-provisioning', 0))`.execute(trx);
}

export async function withMigrationLock<T>(db: Kysely<DB>, run: (connection: Kysely<DB>) => Promise<T>): Promise<T> {
  // A session lock covers the precondition check and Kysely's own migration transaction.
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtextextended('feature-rec-migrations', 0))`.execute(connection);
    try {
      return await run(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended('feature-rec-migrations', 0))`.execute(connection);
    }
  });
}
