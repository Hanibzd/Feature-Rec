import crypto from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { decryptSlackToken } from "../slack-token-crypto";
import type { DB } from "./schema";

function keyVerifier(key: Buffer): string {
  if (key.byteLength !== 32) throw new Error("Slack token encryption key is invalid");
  return crypto.createHmac("sha256", key).update("feature-rec:slack-token-key-check:v1").digest("base64");
}

function matchesVerifier(key: Buffer, verifier: string): boolean {
  const expected = Buffer.from(keyVerifier(key));
  const actual = Buffer.from(verifier);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Caller holds the provisioning lock; pin the key in the same transaction as the first token.
export async function ensureSlackTokenKey(trx: Transaction<DB>, key: Buffer): Promise<void> {
  const row = await trx.selectFrom("slack_token_encryption_key").select("verifier").where("id", "=", 1).executeTakeFirst();
  if (row) {
    if (!matchesVerifier(key, row.verifier)) throw new Error("Slack token encryption key does not match the database verifier");
    return;
  }
  const workspace = await trx.selectFrom("slack_workspaces").select("team_id").limit(1).executeTakeFirst();
  if (workspace) throw new Error("Slack token key verifier is missing; restore it from backup before writing tokens");
  await trx.insertInto("slack_token_encryption_key").values({ id: 1, verifier: keyVerifier(key) }).execute();
}

export async function inspectSlackTokenEncryption(db: Kysely<DB>, key: Buffer | null): Promise<{
  keyError: string | null;
  invalidWorkspaces: Array<{ tenantId: string; teamId: string }>;
}> {
  // One snapshot also covers concurrent first-time provisioning.
  const rows = await db.selectFrom("slack_token_encryption_key as key")
    .fullJoin("slack_workspaces as workspace", (join) => join.onTrue())
    .select(["key.verifier", "workspace.tenant_id", "workspace.team_id", "workspace.bot_token_ciphertext"])
    .execute();
  if (rows.length === 0) return { keyError: null, invalidWorkspaces: [] };
  if (!key) return { keyError: "FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY is required when a Slack token key or workspace is stored", invalidWorkspaces: [] };
  const verifier = rows[0].verifier;
  if (!verifier || !matchesVerifier(key, verifier)) {
    return { keyError: verifier ? "Slack token encryption key does not match the database verifier" : "Slack token key verifier is missing; restore it from backup", invalidWorkspaces: [] };
  }
  const invalidWorkspaces: Array<{ tenantId: string; teamId: string }> = [];
  for (const workspace of rows) {
    if (workspace.team_id === null || workspace.tenant_id === null) continue;
    try {
      decryptSlackToken({ envelope: workspace.bot_token_ciphertext!, teamId: workspace.team_id, key });
    } catch {
      invalidWorkspaces.push({ tenantId: workspace.tenant_id, teamId: workspace.team_id });
    }
  }
  return { keyError: null, invalidWorkspaces };
}
