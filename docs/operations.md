# Operations

This guide is for maintainers and operators who look after the existing GitHub and Slack apps, run
the backend locally or in production, administer its database, and roll back releases. Product
behavior is described in [How Feature-Rec works](product.md), and bringing a customer onto the
hosted service in [Onboarding a tenant](tenant-onboarding.md). For repository structure, local
rendering and the development checks, see the [README](../README.md). Run repository commands from
the repository root unless stated otherwise.

## Existing GitHub and Slack apps

Feature-Rec's production GitHub App and Slack app already exist, and one of each serves every
tenant. Normal operation and [tenant onboarding](tenant-onboarding.md) never register an app:
customers install the existing ones. The settings below are what the backend relies on; keep them,
and change them only together with the backend. Registering an app again is needed only if one is
lost or must be replaced, or for a separate environment; see
[Appendix: registering the apps](#appendix-registering-the-apps). The apps are managed under
**Developer settings → GitHub Apps** of the account that owns the GitHub App, and in the Slack app
dashboard at `https://api.slack.com/apps`.

### GitHub App

The backend authenticates as the App with `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` (see
[Runtime configuration](#runtime-configuration)); literal `\n` sequences in the key are converted to
newlines. Customers install the App on their own organization or user account, so it must stay
installable on any account. The backend mints a repository-scoped installation token for each
operation and stores no GitHub tokens.

The App needs these permissions:

- Checks: read/write
- Pull requests: read/write
- Issues: read/write
- Contents: read
- Metadata: read

Pull request write access is required for the approval and rejection comments that Feature-Rec posts
to the PR conversation. If you add or increase permissions, every customer must approve the updated
permissions on their installation (or reinstall the App). The next operation mints an installation
token with the new grants; no backend restart is needed.

The backend consumes no GitHub webhooks, so the App needs no webhook URL. To rotate the private key,
generate a new key in the App settings, update `GITHUB_PRIVATE_KEY` and let the service restart,
then delete the old key.

### Slack app

The backend verifies every interactivity, event and command request with `SLACK_SIGNING_SECRET`, and
uses `SLACK_APP_ID`, `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` for
[hosted OAuth](#hosted-slack-oauth-configuration). Bot tokens are not configuration: each
workspace's token arrives through its installation and is stored encrypted (see
[Slack token encryption](#slack-token-encryption)). How signed requests are routed and how uninstall
events are handled is described in [Slack lifecycle events](#slack-lifecycle-events).

The app needs these bot scopes:

- `chat:write` — post validation messages and the first-channel greeting
- `files:write` — upload the demo video
- `usergroups:read` — resolve usergroup handles and expand approver groups
- `channels:read` — list the bot's public-channel memberships (routing)
- `groups:read` — same for private channels
- `commands` — added automatically with the `/feature-rec` slash command; must be
  listed explicitly in the OAuth scopes when the app is distributed

`channels:read` and `groups:read` also cover the `conversations.members` checks used
when changing mentions or approvers, so explicit channel selection adds no OAuth
scope and does not require reinstalling an already configured app. `im:read` and
`mpim:read` are not required because routing requests only `public_channel` and
`private_channel`; slash-command replies from DMs use their `response_url` instead
of reading the conversation. Slack's `views.open` method requires no OAuth scope.

Its URLs point at the public backend origin, the host of `FEATURE_REC_BASE_URL`:

```text
Interactivity Request URL: https://<host>/api/slack/interactivity
Event Subscriptions Request URL: https://<host>/api/slack/events
Slash command: /feature-rec -> https://<host>/api/slack/commands
OAuth Redirect URL: https://<host>/api/slack/oauth/callback
```

- The events URL is subscribed to `member_joined_channel`, `app_uninstalled`, and `tokens_revoked`,
  with **Delayed Events** enabled: after Slack's immediate/1 min/5 min retries, delivery retries
  hourly for 24 hours, and apps below 1,000 events per hour are exempt from auto-disable, so a
  temporarily down backend cannot lose the subscription. A missed first join can be repaired
  automatically only when the bot has exactly one channel membership; otherwise use the channel
  command.
- The `/feature-rec` slash command has **Escape channels, users, and links sent to your app**
  enabled, so channel and user mentions arrive with stable `<#C…>` and `<@U…>` ids. Plain channel
  names are intentionally not resolved.
- Distribution is enabled, unlisted, so other workspaces can install the app. Token rotation stays
  disabled: installations with expiring or refreshable tokens are rejected. The app requests no user
  scopes.
- If the public origin changes, update all four URLs together with `FEATURE_REC_BASE_URL`; see
  [Railway deployment](#railway-deployment).

The hosted installer requests exactly the scopes in `SLACK_OAUTH_SCOPES`
([`slack-oauth.ts`](../packages/service/src/slack-oauth.ts)) and rejects an installation that lacks
any of them, so a scope added only in the Slack app settings is never requested. Adding a scope is a
coordinated change:

1. Add the scope to the Slack app's bot scopes.
2. Deploy a release that adds it to `SLACK_OAUTH_SCOPES` without using it at runtime yet. From then
   on, every installation must grant it.
3. Have each workspace reinstall: the customer opens the hosted start URL again and the operator
   provisions the new installation, as for a
   [token replacement](tenant-onboarding.md#change-or-remove-a-tenant).
4. Deploy the release that uses the scope. A workspace that has not reinstalled gets
   `missing_scope`, which surfaces through the check-run error path.

### Hosted Slack OAuth configuration

The backend serves the fixed public installation URL `<FEATURE_REC_BASE_URL>/api/slack/oauth/start`
and its callback. Leave `SLACK_APP_ID`, `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` all absent or
empty to disable both routes, which then return `404`. Otherwise provide all three together;
partial or malformed configuration fails startup without echoing values. Configure
`FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY` before accepting installations: without it the installation
endpoints return `503`. Startup and `/health` need no Slack call. Keep the existing encryption key.
The events, interactivity and command URLs and the app signing secret continue to handle runtime
Slack requests independently of OAuth.

The installation steps a customer follows are in
[Install the Slack app](tenant-onboarding.md#install-the-slack-app). Local tests do not prove that
the Slack app or a deployment is configured; verify a real installation in staging.

## Local backend

Install dependencies using the [README quickstart](../README.md#quickstart).
Create a local environment file:

```bash
cp .env.example .env
```

Fill in the [runtime variables](#runtime-configuration) for the integrations you will
use. The backend needs a reachable Postgres and an explicit `FEATURE_REC_BASE_URL`.
A local health check can use `http://localhost:3000` with `NODE_ENV=development`;
real Actions requests need a public HTTPS tunnel origin as their audience.

Start a tunnel in a separate terminal, for example:

```bash
ngrok http 3000
```

Set `FEATURE_REC_BASE_URL` in `.env` to that public origin, then start the service:

```bash
make dev
```

This loads `.env`, starts or reuses the local Docker Postgres instance, and injects
its `DATABASE_URL`. To use an existing database without Make, export the runtime
variables yourself and run `pnpm run feature-rec:service`; that command does not
load `.env` automatically.

Set the target repository variable `FEATURE_REC_API_URL` to the same tunnel origin and pass
`api-url: ${{ vars.FEATURE_REC_API_URL }}` to the action step. Then onboard a test tenant against
the local backend as described in [Onboarding a tenant](tenant-onboarding.md), using the local admin
commands shown there, before testing review traffic. Real Slack traffic needs a Slack app whose
request URLs point at the tunnel, and a local backend should not use production credentials; see
[Appendix: registering the apps](#appendix-registering-the-apps). Local rendering by itself does not
need the backend or its integration credentials.

## Production image

Build the backend-only image from the repository root:

```bash
docker build -t feature-rec-service:local .
```

The root build context is required because `packages/service` imports `packages/core`. The image
contains compiled JavaScript and production dependencies only; it runs as a non-root user with Node
24 and starts with `node --enable-source-maps dist/index.js`.

To run the image against the Makefile-managed Postgres on Docker Desktop, use a
configured `.env` from the [local backend setup](#local-backend):

```bash
make db
```

```bash
docker run --rm --name feature-rec-service -p 3000:3000 \
  --env-file .env \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/postgres \
  feature-rec-service:local
```

On Linux, add `--add-host=host.docker.internal:host-gateway` to the Docker command.
Check the running image with `curl --fail http://localhost:3000/health` and verify the
compiled admin entrypoint with:

```bash
docker run --rm --entrypoint node feature-rec-service:local dist/admin.js --help
```

For an isolated-database smoke test without live provider credentials, run the
[packaged-service smoke check](#smoke-checks), which is also used by CI.

### Runtime configuration

The runtime contract is:

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `PORT` | Platform supplied | Fastify listener; defaults to `3000` locally |
| `DATABASE_URL` | Required | PostgreSQL connection string |
| `FEATURE_REC_BASE_URL` | Required | Explicit public HTTPS origin; shared audience normalization with the action's `api-url` input |
| `GITHUB_APP_ID` | Required for GitHub operations | GitHub App identifier |
| `GITHUB_PRIVATE_KEY` | Required for GitHub operations | GitHub App signing key |
| `SLACK_SIGNING_SECRET` | Required for Slack review | Slack interaction, event, and command verification |
| `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Optional as a complete group | Hosted Slack OAuth configuration; distinct from the signing secret |
| `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY` | Required when a key verifier, workspace token or pending token is stored | Exactly 32 random bytes encoded as base64; encrypts stored workspace and pending bot tokens |
| `GITHUB_OIDC_ISSUER` | Optional | Trusted HTTPS issuer; defaults to `https://token.actions.githubusercontent.com` |

Configuration is injected at runtime. Do not put secrets in the Dockerfile or image. The backend
uses no persistent filesystem or container volume; review state and channel routing are stored in
PostgreSQL, logs go to stdout/stderr, and uploaded videos are forwarded to Slack rather than
persisted locally.

Only explicit loopback HTTP base URLs are accepted in development/tests; production requires HTTPS.
Credentials, query strings, and fragments are rejected. The audience is the normalized base URL,
with no independent audience override. Discovery/JWKS access is lazy until the first OIDC request,
so a fresh-database `/health` smoke does not call GitHub or Slack.

## Railway deployment

1. Create a Railway backend service connected to this repository and protected production branch.
   Railway builds the root Dockerfile; it does not use Railpack or require a prebuilt registry image.
2. Keep its root directory at `/`; `railway.json` selects the root Dockerfile and limits deploy
   triggers to the backend, core package, and relevant root build files.
3. Add Railway PostgreSQL as a separate service in the same project and region.
4. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the backend so it uses private project
   networking.
5. Add the remaining [runtime variables](#runtime-configuration). Railway injects `PORT` automatically.
6. Generate a Railway domain for initial verification or attach a stable custom domain such as
   `feature-rec.example.com`.
7. Enable GitHub Autodeploys for `main`. Keep Railway's **Wait for CI** disabled because the required
   GitHub Actions workflow runs and smoke-tests the image before merge.

The container connects to PostgreSQL and applies Kysely migrations before Fastify begins listening.
If connection or migration fails, `/health` never becomes available and Railway will not activate the
deployment. `railway.json` configures `/health`, an always-restart policy, zero deployment overlap,
and 60 seconds of graceful draining for in-flight uploads and external API calls. Because every
merge to `main` deploys and migrates automatically, each release that changes the schema follows
[Backup, rollback, and migration](#backup-rollback-and-migration).

After the public origin is stable, configure:

```text
FEATURE_REC_BASE_URL=https://api.feature-rec.com
Slack Interactivity Request URL=https://api.feature-rec.com/api/slack/interactivity
Slack Events Request URL=https://api.feature-rec.com/api/slack/events
Slack Slash Command URL=https://api.feature-rec.com/api/slack/commands
Slack OAuth Redirect URL=https://api.feature-rec.com/api/slack/oauth/callback
Hosted action default=https://api.feature-rec.com
```

Before using this hosted configuration, attach `api.feature-rec.com` through Railway Custom Domains.
Coordinate `FEATURE_REC_BASE_URL` with the Action's `api-url` and consumer overrides or pinned
revisions: the backend's OIDC audience must match the Action's API URL. Keep the generated Railway
hostname available during the transition.

Seal app-level credentials and the Slack token encryption key in Railway where available. Slack bot
tokens live encrypted in PostgreSQL, one per workspace; they arrive through the hosted OAuth
installation, or through the admin command's non-echoing prompt or stdin for
[manual provisioning](tenant-onboarding.md#manual-token-provisioning).

## Hosted Slack OAuth internals

The OAuth routes use `@slack/oauth` with PostgreSQL-backed state and installation stores. The start
route creates a session and redirects to Slack. The callback checks the independent browser binding
before the SDK claims the single-use database session. It exchanges the code once, validates the
normalized app, team, bot, scopes and token model, and cross-checks the live Slack identity before
encrypting a pending token. The completion response shows only the opaque installation ID and the
verified workspace ID; nothing is activated until an operator provisions it.

Cookies use Secure/HttpOnly/SameSite=Lax with a ten-minute lifetime. Callbacks clear
both cookies once admitted for processing. A callback rejected by the local rate
limit or missing encryption-key configuration keeps both cookies and leaves the
session untouched, allowing a retry within its original lifetime after recovery.
The SDK supports one current attempt per browser cookie context;
a second tab or failed callback can require a fresh start. An interrupted exchange
cannot be replayed. SDK network requests have a ten-second timeout with no ordinary
or rate-limit retries; the independent identity check has a five-second timeout.
Responses use no-store/no-referrer and contain no third-party content. Automatic
request logs omit query strings while retaining the socket peer address. Callback
failure logs include fixed phase/category fields and HTTP status, never raw errors
or provider bodies. Invalid callbacks and rejected authorization codes return 400;
unsupported installations/provider rejections return 502; storage, key configuration
and transient provider failures return 503. A 5xx after processing begins still
requires a fresh start: it does not make an already claimed code replayable.

Each service process permits at most 30 starts and 120 callbacks per minute;
excess requests return 429 with Retry-After. These are deployment-wide per-process
budgets, independent of untrusted forwarded IP headers; multiple replicas each
have their own budget. Limited start requests create no session or replacement
cookie. Session cleanup runs once per minute, at most 100 records per batch,
without overlapping sweeps. Closing the server stops the timer and awaits a sweep.

### Persistent installation storage

Migration [`0009_slack_oauth_installations`](../packages/service/src/storage/migrations/0009_slack_oauth_installations.ts)
adds one temporary table. The [storage operations](../packages/service/src/storage/slack-oauth.ts)
create opaque installation IDs, store only SHA-256 hashes of independent random
state and browser-binding secrets, and give a new session ten minutes to complete
its exchange. A matching, unexpired session can be claimed once across processes;
claiming moves it from `awaiting_callback` to `exchanging`. A claimed exchange
cannot be reclaimed after a crash; the user must start a fresh authorization.

Staging stores a verified workspace/bot identity and an encrypted pending token,
clears session secrets, changes the status to `pending`, and clears `expires_at`.
Pending installations have no local expiry; they remain until activation or cancellation. The
caller must validate the Slack installation before staging it. Encryption uses the existing stable
key with the workspace ID as authenticated data. Staging a reinstall does not modify the active
workspace credential, and runtime Slack handlers never read pending tokens. In the same
transaction, staging checks/pins the key before writing ciphertext and rechecks
expiry before the write. If it expires or the write fails, rollback also removes
any verifier inserted by that attempt. A missing verifier can be bootstrapped only
when no active workspace or pending ciphertext exists; no pending row is exempted.

The internal consumption operation requires the same database transaction as
validated integration writes and tenant activation. It verifies the enabled
tenant, matching Slack workspace/bot and GitHub installation, and equality of the
exact validated, active and pending encrypted envelopes. It then records `consumed` with the
resulting tenant/GitHub installation IDs and clears the staged ciphertext. The caller must
let consumption errors abort that transaction. Session expiry is checked after
acquiring locks during claim and staging. Consumption checks availability and
pairing under lock, including cancellation or consumption by another caller.
Pending-ID provisioning copies the validated envelope unchanged into active storage.
Manual-token provisioning still encrypts raw input; see the
[hosted OAuth design](plans/feature-rec-oidc-multitenancy-plan.md#pr-b2--hosted-slack-oauth-installation).

The status operation returns only the installation ID, verified identity, dates,
lifecycle status and consumed result IDs. Pending records report no expiry. It
reports an elapsed OAuth session as `expired` even before cleanup. Cancellation changes an
unconsumed record to `cancelled` and clears its secrets and ciphertext. Status and cancellation are
operator-only commands, not public HTTP endpoints.

Cleanup handles at most 100 records per call by default, with an explicit batch
limit of 1–1,000. It uses `FOR UPDATE SKIP LOCKED` so concurrent callers skip busy
records. Pending installations are never aged out. Expired OAuth sessions have
their secrets cleared; cancellation and consumption clear pending ciphertext. Terminal
records become eligible for deletion 24 hours after expiry/cancellation, or 24 hours
after consumption for a consumed receipt. Deletion requires a cleanup call and is
bounded by its batch size. The configured OAuth server schedules these sweeps;
pending installations are retained until explicit consumption or cancellation.

## Slack lifecycle events

Interactivity, events, and commands use the shared app signing secret, then route by the signed
workspace ID to an enabled tenant and its decrypted token. Missing/unknown workspaces have no
fallback. Membership events compare the user with the stored bot user ID before decrypting;
`auth.test` runs when provisioning/replacing tokens and when verifying lifecycle revocation.

A signed `app_uninstalled` or `tokens_revoked` event triggers `auth.test` against the current stored
credential. A valid token preserves the workspace; only `token_revoked` or `account_inactive` permit
deletion. Slack's [`invalid_auth` error](https://docs.slack.dev/reference/methods/auth.test/) can
also mean an IP allowlist rejection, so it leaves the workspace intact and returns `503` for Slack to
retry. Provider outages, rate limits, identity mismatches, and decryption failures also return
`503`. Deletion compares the checked ciphertext under the provisioning lock and atomically removes
only that team's workspace/settings and disables its tenant. A concurrent reinstall writes fresh
randomized ciphertext and is preserved, including when Slack reuses the same bot user ID. Cleanup
also works for disabled tenants. Reinstallation must validate both integrations before enabling it
again.

Lifecycle acknowledgement waits for verification and committed cleanup. Slow Slack responses or
contention on the provisioning lock can exceed Slack's
[three-second acknowledgement window](https://docs.slack.dev/apis/events-api/#responding)
and trigger redelivery; the credential check and conditional deletion remain safe to retry.
Reliable immediate acknowledgement would require a durable event queue with retrying workers.
Acknowledging before starting in-memory background cleanup could lose the event on a process crash.

## Slack token encryption

Generate `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY` once with `openssl rand -base64 32`, seal it in
the hosted environment, and keep it stable.

The first successful provisioning or pending-token staging transaction stores an independent
HMAC-SHA256 key verifier in the singleton `slack_token_encryption_key` table; subsequent token writes
and startup must match it. Pending tokens pin the key even when no tenant exists yet. If credentials
exist but their verifier is missing, writes fail instead of establishing a replacement verifier.

Startup decrypt-checks active and pending tokens after checking that verifier. A wrong/missing key
or missing verifier prevents startup. A corrupt active token produces event
`SLACK_TOKEN_DECRYPTION_FAILED` with tenant/workspace IDs; a corrupt pending token produces
`SLACK_PENDING_TOKEN_DECRYPTION_FAILED` with installation/workspace IDs. These individual failures
allow startup for other tenants but appear as issues in the
[`validate-integrity`](#administration-commands) report. Repair the affected
active credentials by
[provisioning the tenant again](tenant-onboarding.md#change-or-remove-a-tenant), or cancel an
unusable pending installation with `cancel-slack-installation` and start a fresh
authorization through the hosted start URL. Neither tokens nor ciphertexts are logged. Back up the
verifier with the database and the key separately. Never delete the verifier to bypass a key
mismatch; restore the matching backup/key.

## Administration commands

The image includes the compiled `node dist/admin.js` control plane; it does not depend on `tsx` or
development dependencies. Production commands require an explicit `--environment` label, which must
match `RAILWAY_ENVIRONMENT_NAME` when that is set, and every write requires `--confirm`. Unsupported
or repeated flags are rejected. Run them inside Railway's private network:

```bash
railway ssh -- node dist/admin.js migration-status --environment production
```

```bash
railway ssh -- node dist/admin.js validate-integrity --environment production
```

| Command | Purpose |
| --- | --- |
| `migration-status` | List every registered migration with its execution time. |
| `migrate-to <migration> --confirm [--expect-current <migration>]` | Migrate to the named migration. A downgrade also requires `--expect-current`, `--service-stopped` and `--traffic-paused`. The current-migration check and the migration share a lock with startup migrations; the command exits nonzero on any failure. |
| `validate-integrity` | Read-only integrity report for what the schema cannot enforce. It flags enabled tenants without exactly one Slack workspace and one GitHub installation, a missing or mismatched encryption-key verifier, and active or pending tokens that cannot be decrypted. Run it after a restore or a key change. It exits nonzero when it reports an issue. |
| `provision-tenant` | Pair and activate a tenant; see [Provision the tenant](tenant-onboarding.md#provision-the-tenant). |
| `slack-installation-status --slack-installation-id <uuid>` | Show a sanitized pending-installation record; exits nonzero if it does not exist. |
| `cancel-slack-installation --confirm --slack-installation-id <uuid>` | Cancel an unconsumed installation and clear its staged secrets. |
| `disable-tenant --confirm --tenant-id <uuid>` | Disable an enabled tenant without deleting anything; see [Change or remove a tenant](tenant-onboarding.md#change-or-remove-a-tenant). It exits nonzero if the tenant does not exist or is already disabled. |

`migration-status`, `migrate-to`, `slack-installation-status`, `cancel-slack-installation` and
`disable-tenant` need only `DATABASE_URL`, so they keep working when integration configuration is
broken.
`validate-integrity` and `provision-tenant` also read the runtime configuration, including
the encryption key. The commands print no secrets.

For a schema downgrade, follow [Schema downgrade](#schema-downgrade). Do not downgrade from a live
service shell.

## Backup, rollback, and migration

Railway runs PostgreSQL separately from the stateless backend. Verify the database version and backup
policy, then perform at least one `pg_dump`/`pg_restore` drill before the state becomes critical.
Rollback depends on both the artifact and stored tenant data; automatic down migrations are not used.

Every service start applies all registered migrations before listening, so each schema-changing
release is a separate deploy with its own gate. The registered migrations are:

| Migration | Change |
| --- | --- |
| `0001_initial` | Review cycles and processed Slack interactions |
| `0002_channel_routing` | Bot channel memberships and per-channel settings |
| `0003_nullable_legacy_config` | Make the retired configuration columns nullable |
| `0004_last_left_at` | Membership rejoin boundary for the retired channel queue |
| `0005_explicit_channel_routing` | Explicit per-workspace routes in `team_channel_routes` |
| `0006_drop_legacy_bot_channels` | Drop the membership snapshot |
| `0007_mention_modes` | Mention modes and audiences; every channel follows approvers |
| `0008_multitenant_expand` | Tenants, Slack workspaces, GitHub installations, key verifier and nullable cycle identity |
| `0009_slack_oauth_installations` | Hosted OAuth sessions and pending installations |
| `0010_multitenant_enforce` | Required cycle identity and the cascading `channel_settings_team_id_fkey` |
| `0011_multitenant_contract` | Drop `team_channel_routes` and the legacy cycle columns |

No supported release runs on a schema older than `0011_multitenant_contract`, so do not migrate
below it. Its `down()` cannot restore the dropped legacy values; recovering a state from before it
requires a database backup.

### Schema downgrade

Kysely rejects a recorded migration that an older release does not register. To roll back a release
that added a migration, migrate down with the newer release's admin command before starting the
older release. Never hand-edit migration records or renumber an applied migration.

1. Pause runner and Slack writes, drain active requests, and verify a fresh database backup and the
   older release to restore. Disable automatic deploys and stop all service instances through the
   platform's deployment controls; killing a process is not enough with an always-restart policy.
2. From a **separate maintenance process**, run the newer release's admin command against the
   private database, for example through a private `railway connect postgres --tunnel-only`
   connection. Do not use `railway ssh` inside a still-running service. Check `migration-status`.
3. Migrate down:

   ```bash
   node dist/admin.js migrate-to <target-migration> --environment production \
     --expect-current <current-migration> --service-stopped --traffic-paused --confirm
   ```

   The flags acknowledge actual operator actions; they do not stop Railway for you. The
   expected-current check and the migration are serialized with startup migrations, but a later
   start of the newer release would apply its migrations again.
4. Verify migration status, start only the older release, check `/health` and an existing review
   flow, then resume traffic. Restore automatic deploys only once their target is safe for the
   chosen schema.

Do not expose PostgreSQL publicly.

## Moving providers

Moving to another provider requires no application changes: restore the PostgreSQL backup, configure
the same environment variables, deploy the same OCI image, wait for migrations and `/health`, test
GitHub and Slack against a staging hostname, and then switch DNS. A custom domain keeps integration
URLs stable across that move.

## Smoke checks

Run the [development validation gate](../README.md#validation) first. The production
image has a separate local test using a uniquely created temporary database:

```bash
docker build --tag feature-rec-service:local .
```

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  pnpm --filter @feature-rec/service exec tsx scripts/service-image-selftest.mts feature-rec-service:local
```

The harness checks that the compiled admin command prints its help, that the service migrates the
temporary database and serves `/health` with hosted OAuth disabled and configured, and that partial
OAuth configuration fails startup. It uses fixture values only and never loads `.env` or production
credentials. On failure, it prints the container logs before it removes the containers and the
database.

The following checks exercise real integrations in staging.

In a staging Slack workspace, also verify that the first join gets one greeting and later joins are
silent; switch from a DM and confirm there is one ephemeral reply and no channel-visible post;
confirm each channel's mention mode and approvers survive the switch; exercise `mention approvers`,
`mention off`, and a custom audience; reject a mention or approver whose usergroup contains a
non-member; and remove the selected channel to confirm delivery fails without moving to another
membership, then re-invite it and confirm delivery resumes.

Run two tenant workflows concurrently with different workspaces/channels. Confirm videos, settings,
approvals, comments, and check runs stay within their tenant. A signed interaction from workspace A
carrying a cycle-B ID must leave B unchanged. Rename one repository, remove/re-add its installation
grant, and uninstall/re-provision one workspace; each operation must leave the other tenant working.
An unrelated member-join event must not call `auth.test` or decrypt the token. Finally, confirm an
already-posted stale validation can have its buttons cleared after GitHub access has disappeared.

## Appendix: registering the apps

Register a new GitHub App or Slack app only when the existing one is deleted, compromised beyond
what rotating its credentials fixes, or must otherwise be replaced, or when a separate environment
needs its own apps. Request URLs belong to a Slack app, so a staging deployment or a local backend
behind a tunnel cannot share the production Slack app, and neither should use production
credentials.

Replacing a production app affects every tenant:

- A new GitHub App has a new App ID and private key. Every customer must install it, and every
  tenant must be provisioned again with its new installation ID; provisioning also needs a fresh
  Slack installation, as in
  [Change or remove a tenant](tenant-onboarding.md#change-or-remove-a-tenant).
- A new Slack app has a new signing secret and client credentials and issues different bot tokens.
  Every workspace must install it through the hosted start URL, and every tenant must be provisioned
  again.

### GitHub App registration

1. Under **Developer settings → GitHub Apps** of the owning organization or account, create a GitHub
   App that can be installed on any account, with the permissions listed in
   [GitHub App](#github-app) and no active webhook.
2. Generate a private key, then set `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` in the backend
   environment.

### Slack app registration

1. Create an app in the Slack app dashboard at `https://api.slack.com/apps`.
2. Configure the bot scopes, request URLs, event subscriptions with **Delayed Events**, the
   `/feature-rec` slash command with escaping, and the OAuth redirect URL listed in
   [Slack app](#slack-app). A local backend uses its tunnel origin as `<host>`.
3. Enable unlisted distribution and keep token rotation disabled.
4. Set `SLACK_SIGNING_SECRET`, `SLACK_APP_ID`, `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in the
   backend environment. Keep the deployment's `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY`; a new
   environment generates its own as described in [Slack token encryption](#slack-token-encryption).
5. Workspaces then install the app through the hosted start URL; see
   [Onboarding a tenant](tenant-onboarding.md).
