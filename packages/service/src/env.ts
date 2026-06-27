import path from "node:path";

export type ServiceEnv = {
  port: number;
  baseUrl: string;
  dbPath: string;
  runnerToken: string;
  githubToken: string;
  githubAppId: string;
  githubPrivateKey: string;
  slackBotToken: string;
  slackSigningSecret: string;
};

export function readEnv(env = process.env): ServiceEnv {
  return {
    port: Number(env.PORT) || 3000,
    baseUrl: env.FEATURE_REC_BASE_URL ?? `http://localhost:${Number(env.PORT) || 3000}`,
    dbPath: env.FEATURE_REC_DB_PATH ?? path.resolve(process.cwd(), "data/feature-rec.sqlite"),
    runnerToken: env.FEATURE_REC_RUNNER_TOKEN ?? "",
    githubToken: env.FEATURE_REC_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? "",
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubPrivateKey: (env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    slackBotToken: env.SLACK_BOT_TOKEN ?? "",
    slackSigningSecret: env.SLACK_SIGNING_SECRET ?? "",
  };
}
