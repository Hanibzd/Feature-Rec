#!/usr/bin/env node
import { Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import {
  backfillMultitenancy,
  prepareRollbackToA,
  provisionTenant,
  validateMultitenancy,
  type AdminProviders,
} from "./admin-operations";
import { readEnv, type ServiceEnv } from "./env";
import { GitHubClient } from "./github";
import { SlackClient } from "./slack";
import { migrationProvider } from "./storage/migrations";
import type { DB } from "./storage/schema";

const HELP = `Feature-Rec production administration

Usage:
  node dist/admin.js migration-status --environment <name>
  node dist/admin.js migrate-to <migration> --environment <name> --confirm
    [--expect-current <migration>]
  node dist/admin.js validate-contract-readiness --environment <name> [--require-future-cycle-keys]
  node dist/admin.js backfill-multitenancy --environment <name> (--dry-run | --apply --confirm)
    [--tenant-id <uuid>] [--rebuild-cycle-keys --traffic-paused]
  node dist/admin.js provision-tenant --environment <name> --confirm
    --installation-id <id> --repository <owner/repo> [--tenant-id <uuid>]
    [--selected-channel-id <id>] [--replace-pairing]
    (reads the Slack bot token from a non-echoing TTY prompt or stdin)
  node dist/admin.js prepare-rollback-to-a --environment <name> (--dry-run | --apply --confirm)
    [--traffic-paused]

Run production commands inside Railway with:
  railway ssh -- node dist/admin.js <subcommand> ...
`;

type ParsedArgs = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | true>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, positionals, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requireEnvironment(args: ParsedArgs): string {
  const environment = requireFlag(args, "environment");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment)) {
    throw new Error("--environment must be a short environment label");
  }
  const detected = process.env.RAILWAY_ENVIRONMENT_NAME;
  if (detected && detected !== environment) {
    throw new Error(
      `--environment ${environment} does not match RAILWAY_ENVIRONMENT_NAME ${detected}`,
    );
  }
  return environment;
}

function requireConfirmation(args: ParsedArgs): void {
  if (!boolFlag(args, "confirm")) throw new Error("This write requires --confirm");
}

function requireMode(args: ParsedArgs): { apply: boolean } {
  const dryRun = boolFlag(args, "dry-run");
  const apply = boolFlag(args, "apply");
  if (dryRun === apply) throw new Error("Choose exactly one of --dry-run or --apply");
  if (apply) requireConfirmation(args);
  return { apply };
}

function requireEncryptionKey(env: ServiceEnv): Buffer {
  if (!env.slackTokenEncryptionKey) {
    throw new Error("FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY is required for this command");
  }
  return env.slackTokenEncryptionKey;
}

function parseRepository(value: string): { owner: string; repo: string } {
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new Error("--repository must be in owner/repo form");
  return { owner: match[1], repo: match[2] };
}

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const secret = Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
    if (!secret || /[\r\n]/.test(secret)) throw new Error("stdin must contain exactly one Slack bot token");
    return secret;
  }

  const tty = process.stdin;
  if (!tty.setRawMode) throw new Error("Cannot disable terminal echo; pipe the Slack bot token on stdin");
  process.stderr.write("Slack bot token: ");
  tty.setRawMode(true);
  tty.resume();
  tty.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      tty.setRawMode?.(false);
      tty.pause();
      tty.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Cancelled"));
        if (character === "\r" || character === "\n") {
          if (!value) return finish(new Error("Slack bot token must not be empty"));
          return finish();
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    tty.on("data", onData);
  });
}

function providers(env: ServiceEnv): AdminProviders {
  const github = new GitHubClient(env);
  return {
    inspectSlackToken: async (token) => {
      const slack = new SlackClient({ ...env, slackBotToken: token });
      const [identity, channelIds] = await Promise.all([
        slack.botIdentity(),
        slack.listBotChannels(),
      ]);
      return { teamId: identity.teamId, botUserId: identity.userId, channelIds };
    },
    resolveRepository: (owner, repo) => github.resolveRepository(owner, repo),
    inspectInstallationRepository: (installationId, owner, repo) =>
      github.inspectInstallationRepository(installationId, owner, repo),
  };
}

function print(environment: string, value: unknown): void {
  process.stdout.write(`${JSON.stringify({ environment, ...((value ?? {}) as object) }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.command === "--help" || boolFlag(args, "help")) {
    process.stdout.write(HELP);
    return;
  }

  const environment = requireEnvironment(args);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }),
  });
  try {
    if (args.command === "migration-status") {
      const migrations = await new Migrator({ db, provider: migrationProvider }).getMigrations();
      print(environment, {
        migrations: migrations.map((migration) => ({
          name: migration.name,
          status: migration.executedAt ? "executed" : "pending",
          executedAt: migration.executedAt?.toISOString() ?? null,
        })),
      });
      return;
    }

    if (args.command === "migrate-to") {
      requireConfirmation(args);
      const target = args.positionals[0];
      if (!target || args.positionals.length !== 1) throw new Error("migrate-to requires exactly one migration name");
      const available = await migrationProvider.getMigrations();
      if (!(target in available)) throw new Error(`Unknown migration target: ${target}`);
      const migrator = new Migrator({ db, provider: migrationProvider });
      const before = (await migrator.getMigrations()).filter((row) => row.executedAt).at(-1)?.name;
      const expectedCurrent = flag(args, "expect-current");
      if (expectedCurrent && before !== expectedCurrent) {
        throw new Error(
          `Expected current migration ${expectedCurrent}, found ${before ?? "none"}`,
        );
      }
      const result = await migrator.migrateTo(target);
      if (result.error || result.results?.some((row) => row.status !== "Success")) {
        throw result.error instanceof Error
          ? result.error
          : new Error(`Migration failed: ${String(result.error ?? "non-success result")}`);
      }
      const current = (await migrator.getMigrations()).filter((row) => row.executedAt).at(-1)?.name;
      if (current !== target) throw new Error(`Expected migration ${target}, found ${current ?? "none"}`);
      print(environment, { target, results: result.results ?? [] });
      return;
    }

    if (args.command === "prepare-rollback-to-a") {
      const mode = requireMode(args);
      const report = await prepareRollbackToA({
        db,
        apply: mode.apply,
        trafficPaused: boolFlag(args, "traffic-paused"),
      });
      print(environment, report);
      if (!report.ok) process.exitCode = 1;
      return;
    }

    const env = readEnv();
    if (args.command === "validate-contract-readiness") {
      const report = await validateMultitenancy({
        db,
        encryptionKey: env.slackTokenEncryptionKey,
        requireFutureCycleKeys: boolFlag(args, "require-future-cycle-keys"),
      });
      print(environment, report);
      if (!report.ok) process.exitCode = 1;
      return;
    }

    if (args.command === "backfill-multitenancy") {
      const mode = requireMode(args);
      const report = await backfillMultitenancy({
        db,
        providers: providers(env),
        slackBotToken: env.slackBotToken,
        encryptionKey: requireEncryptionKey(env),
        tenantId: flag(args, "tenant-id"),
        apply: mode.apply,
        rebuildCycleKeys: boolFlag(args, "rebuild-cycle-keys"),
        trafficPaused: boolFlag(args, "traffic-paused"),
      });
      print(environment, report);
      if (report.issues.length > 0 || (report.validation && !report.validation.ok)) process.exitCode = 1;
      return;
    }

    if (args.command === "provision-tenant") {
      requireConfirmation(args);
      const encryptionKey = requireEncryptionKey(env);
      const installationId = requireFlag(args, "installation-id");
      const repository = parseRepository(requireFlag(args, "repository"));
      const token = await readSecret();
      const report = await provisionTenant({
        db,
        providers: providers(env),
        slackBotToken: token,
        encryptionKey,
        installationId,
        repository,
        tenantId: flag(args, "tenant-id"),
        selectedChannelId: flag(args, "selected-channel-id"),
        replacePairing: boolFlag(args, "replace-pairing"),
      });
      print(environment, report);
      return;
    }

    throw new Error(`Unknown admin command: ${args.command}`);
  } finally {
    await db.destroy();
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Feature-Rec admin failed: ${message}\n`);
  process.exitCode = 1;
});
