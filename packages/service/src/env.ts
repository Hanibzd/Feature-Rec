import { parseSlackTokenEncryptionKey } from "./slack-token-crypto";

export const DEFAULT_GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export type ServiceEnv = {
  port: number;
  baseUrl: string;
  databaseUrl: string;
  runnerToken: string;
  githubToken: string;
  githubAppId: string;
  githubPrivateKey: string;
  slackBotToken: string;
  slackSigningSecret: string;
  slackTokenEncryptionKey: Buffer | null;
  githubOidcIssuer: string;
};

function readOidcIssuer(value: string | undefined): string {
  const raw = value ?? DEFAULT_GITHUB_OIDC_ISSUER;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("GITHUB_OIDC_ISSUER must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("GITHUB_OIDC_ISSUER must be an HTTPS URL without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function readEnv(env = process.env): ServiceEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    port: Number(env.PORT) || 3000,
    baseUrl: env.FEATURE_REC_BASE_URL ?? `http://localhost:${Number(env.PORT) || 3000}`,
    databaseUrl,
    runnerToken: env.FEATURE_REC_RUNNER_TOKEN ?? "",
    githubToken: env.FEATURE_REC_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? "",
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubPrivateKey: (env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    slackBotToken: env.SLACK_BOT_TOKEN ?? "",
    slackSigningSecret: env.SLACK_SIGNING_SECRET ?? "",
    slackTokenEncryptionKey: parseSlackTokenEncryptionKey(
      env.FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY,
    ),
    githubOidcIssuer: readOidcIssuer(env.GITHUB_OIDC_ISSUER),
  };
}
