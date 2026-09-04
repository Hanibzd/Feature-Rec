# Feature-Rec

Feature-Rec turns frontend-visible PR changes into a Slack validation flow:

1. A ready PR opens, becomes ready, or receives a follow-up commit.
2. The GitHub Action runs an LLM classifier on the full PR diff.
3. If no frontend-visible change is found, the `Feature-Rec` Check Run is accepted.
4. If a frontend-visible change is found, the action reuses AutoDemo to render a Remotion MP4.
5. The Feature-Rec backend uploads the video to the workspace's Slack review channel and posts validation buttons.
6. `Good to merge` accepts the Check Run.
7. `Needs changes` opens a required Slack modal, then posts the PR Conversation comment mentioning the PR author, and rejects the Check Run.

For this hackathon run, Feature-Rec intentionally ignores backend-only product changes. If the classifier says a change is frontend-visible but the action cannot extract TSX/JSX source to reproduce, the Check Run fails clearly instead of sending a non-UI summary video.

## Onboarding a Repository

Three actions, no configuration file:

1. Install the Feature-Rec GitHub App on the repository.
2. Copy `examples/feature-rec-workflow.yaml` to `.github/workflows/feature-rec.yaml` and add the
   `FEATURE_REC_RUNNER_TOKEN` and `ANTHROPIC_API_KEY` secrets.
3. Invite `@Feature-Rec` to the Slack review channel.

Opening a PR with a frontend-visible change then posts the validation video and buttons in that
channel. Legacy `.github/feature-rec-config.yaml` files are ignored; delete them at leisure.
The action uses the hosted backend by default. Self-hosted deployments set the optional `api-url`
action input to their own public origin.

## Channel Routing

All repos in a Slack workspace share one explicitly selected review channel. The first channel
where the bot joins is selected automatically and receives the active greeting; later joins are
silent. Anyone in the workspace can select another channel with
`/feature-rec channel #channel-name` as long as the bot is currently a member of the target.
Removing the bot from the selected channel does not promote or notify another channel. The route is
retained, so re-inviting the bot resumes delivery there; alternatively, run the channel command from
any workspace conversation or DM to switch. The selected channel is checked against live Slack
membership when each validation is posted. Membership is honored exactly as reported by Slack, with no
shared-channel filtering. **Do not invite `@Feature-Rec` to externally shared (Slack Connect)
channels**: validation videos and PR information will be posted there, visible to the external
organization. Every message identifies its repo as `owner/repo#N`.

If there is no saved route and exactly one live membership, delivery repairs a missed first-join
event by selecting it and emits the same active greeting after rechecking the live route. With
several memberships it refuses to guess and asks a user to run the channel command. If the selected
channel is unavailable when a validation is ready, no Slack message is posted and the Check Run
fails with instructions to re-invite the bot or select another channel.

`team_channel_routes` is the persistent routing source of truth, with one selected channel per Slack
workspace. `channel_settings` is the source of truth for each channel's mention mode, custom mention
audience, and approver policy. A never-configured channel uses virtual defaults (follow approvers,
unrestricted approval) without inserting a settings row. Bot membership is read live from Slack for
selection and availability checks; it is not persisted locally.

## Slash Commands

`/feature-rec` can be run from any conversation or DM in the installed workspace; every reply is
ephemeral. Setting commands always read and update the selected review channel, not the invocation
conversation. `/feature-rec` and `/feature-rec help` return the same general help. Configuration
subcommands without arguments show the current approval/notification summary plus detailed usage.

| Command | Effect |
| --- | --- |
| `/feature-rec channel #channel-name` | Select a public or private bot channel as the workspace review destination. The target must be an escaped Slack channel mention. Switching restores that channel's settings (or the virtual defaults) without copying or rewriting them. |
| `/feature-rec mention approvers` | Mention the channel's current approvers whenever a validation is posted. This is the default. Unrestricted approval resolves to `@channel`. |
| `/feature-rec mention off` | Post validation requests without mentioning anyone. |
| `/feature-rec mention @here\|@channel\|@usergroup\|@user…` | Mention a custom audience, independently of later approver changes. `@channel` must be alone; `@here` may mix with users or groups. |
| `/feature-rec approvers @channel\|@usergroup\|@user…` | Restrict who may use the approval buttons. Default: anyone in the channel. `@channel` clears the restriction. Unauthorized clicks are answered ephemerally with "Only … can approve." |
| `/feature-rec status` | Show the selected channel, availability, and the shared approval/notification summary. |

Direct users and every member returned for a selected active usergroup must belong to the selected
channel when a custom mention or approver setting is saved. Disabled usergroups are excluded from
Slack lookups, and empty usergroups are rejected. `@here` and `@channel` do not need individual
membership validation. Membership is checked at configuration time only; later membership changes
do not rewrite stored settings or block delivery. A channel switch itself does not revalidate or
rewrite saved settings.

## Local Demo Backend

Start the backend (it needs a reachable Postgres and fails startup without `DATABASE_URL`):

```bash
make db     # local Postgres in docker (idempotent)
make dev    # injects DATABASE_URL and runs the service on :3000
```

Or without make: export `DATABASE_URL` yourself and run `pnpm feature-rec:service`. Either way, set `FEATURE_REC_RUNNER_TOKEN` in `.env` — runner calls are rejected with 401 without it.

Expose it:

```bash
ngrok http 3000
```

Set the demo repository variable and pass `api-url: ${{ vars.FEATURE_REC_API_URL }}` to the
Feature-Rec action step:

```text
FEATURE_REC_API_URL=https://<ngrok-host>
FEATURE_REC_RUNNER_TOKEN=<shared secret matching the backend env>
```

## Production Image

Build the backend-only image from the repository root:

```bash
docker build -t feature-rec-service:local .
```

The root build context is required because `packages/service` imports `packages/core`. The image
contains compiled JavaScript and production dependencies only; it runs as a non-root user with Node
24 and starts with `node --enable-source-maps dist/index.js`.

The runtime contract is:

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `PORT` | Platform supplied | Fastify listener; defaults to `3000` locally |
| `DATABASE_URL` | Required | PostgreSQL connection string |
| `FEATURE_REC_BASE_URL` | Required when hosted | Stable public HTTPS origin |
| `FEATURE_REC_RUNNER_TOKEN` | Required | Bearer token shared with the GitHub Action |
| `GITHUB_APP_ID` | Required for GitHub App mode | GitHub App identifier |
| `GITHUB_PRIVATE_KEY` | Required for GitHub App mode | GitHub App signing key |
| `FEATURE_REC_GITHUB_TOKEN` | Optional | Local/demo fallback for GitHub authentication |
| `SLACK_BOT_TOKEN` | Required for Slack review | Slack Web API authentication |
| `SLACK_SIGNING_SECRET` | Required for Slack review | Slack interaction, event, and command verification |
| `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY` | Required after multitenancy backfill | Exactly 32 random bytes encoded as base64; encrypts persisted Slack bot tokens |
| `GITHUB_OIDC_ISSUER` | Optional preparation seam | Valid HTTPS issuer URL; defaults to GitHub Actions and becomes active in deploy B |

Configuration is injected at runtime. Do not put secrets in the Dockerfile or image. The backend
uses no persistent filesystem or container volume; review state and channel routing are stored in
PostgreSQL, logs go to stdout/stderr, and uploaded videos are forwarded to Slack rather than
persisted locally.

## Railway Deployment

1. Create a Railway backend service connected to this repository and protected production branch.
2. Keep its root directory at `/`; `railway.json` selects the root Dockerfile and limits deploy
   triggers to the backend, core package, and relevant root build files.
3. Add Railway PostgreSQL as a separate service in the same project and region.
4. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the backend so it uses private project
   networking.
5. Add the remaining runtime variables from the table above. Railway injects `PORT` automatically.
6. Generate a Railway domain for initial verification or attach a stable custom domain such as
   `feature-rec.example.com`.
7. Enable GitHub Autodeploys for `main`. Keep Railway's **Wait for CI** disabled because the required
   GitHub Actions workflow runs and smoke-tests the image before merge.

The container connects to PostgreSQL and applies Kysely migrations before Fastify begins listening.
If connection or migration fails, `/health` never becomes available and Railway will not activate the
deployment. `railway.json` configures `/health`, an always-restart policy, zero deployment overlap,
and 60 seconds of graceful draining for in-flight uploads and external API calls.

After the public origin is stable, configure:

```text
FEATURE_REC_BASE_URL=https://feature-rec-production.up.railway.app
Slack Interactivity Request URL=https://feature-rec-production.up.railway.app/api/slack/interactivity
Slack Events Request URL=https://feature-rec-production.up.railway.app/api/slack/events
Slack Slash Command URL=https://feature-rec-production.up.railway.app/api/slack/commands
Hosted action default=https://feature-rec-production.up.railway.app
```

This generated Railway hostname is temporary. Before customer workflows depend on it, attach
`api.feature-rec.com` through Railway Custom Domains, change the action default to
`https://api.feature-rec.com`, and keep the Railway hostname available during the transition.

Use one strong value for `FEATURE_REC_RUNNER_TOKEN` in both Railway and the target repository. Seal
GitHub and Slack secrets in Railway where available. The backend does not consume GitHub webhooks.

### Backup, rollback, and migration

Railway runs PostgreSQL separately from the stateless backend. Verify the database version and backup
policy, then perform at least one `pg_dump`/`pg_restore` drill before the state becomes critical.
Application rollback redeploys the previous healthy image; schema migrations must remain backward
compatible because automatic down migrations are not used.

Migration `0008_multitenant_expand` adds only nullable/new schema and relaxes the legacy repository
name columns. It retains `team_channel_routes`, prefers a populated
`slack_workspaces.selected_channel_id`, and dual-writes both fields. Its `down()` refuses to proceed
if any cycle lacks the legacy `owner`/`repo` values needed by deploy A.

The image includes the compiled `node dist/admin.js` control plane; it does not depend on `tsx` or
development dependencies. Production commands require an explicit `--environment` label, and every
write requires `--confirm`. Run them inside Railway's private network:

```bash
railway ssh -- node dist/admin.js migration-status --environment production
railway ssh -- node dist/admin.js backfill-multitenancy --environment production --dry-run
railway ssh -- node dist/admin.js backfill-multitenancy --environment production --apply --confirm
railway ssh -- node dist/admin.js validate-contract-readiness --environment production
```

Generate `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY` once with `openssl rand -base64 32`, seal it in
the hosted environment, and keep it stable. Backfill validates the legacy Slack team, resolves every
legacy repository through the GitHub App, detects future cycle-key collisions, writes one disabled
tenant transactionally, and enables it only after validation. Deploy A still uses shared runner
authentication, so do not provision a second tenant yet.

For the final pre-cutover reconciliation, pause new workflows and drain active runs, then use
`backfill-multitenancy --apply --confirm --rebuild-cycle-keys --traffic-paused`. To roll the database
back to the pre-A schema, first run
`migrate-to 0007_mention_modes --expect-current 0008_multitenant_expand --confirm` from the deploy-A
artifact, verify the status, and only then start the older image. If the normal image cannot become
healthy, run the retained artifact against a private `railway connect postgres --tunnel-only`
connection; do not make PostgreSQL public.

Migration `0006_drop_legacy_bot_channels` permanently removes the obsolete membership snapshot after
explicit routing has completed its observation window. Before deploying it, verify every expected
workspace has a `team_channel_routes` row and retain a database snapshot or `bot_channels` export.
After it runs, rollback is limited to explicit-route service versions; queue-based binaries are no
longer supported. Restoring membership history requires the pre-cleanup snapshot, not a down
migration.

Moving to another provider requires no application changes: restore the PostgreSQL backup, configure
the same environment variables, deploy the same OCI image, wait for migrations and `/health`, test
GitHub and Slack against a staging hostname, and then switch DNS. A custom domain keeps integration
URLs stable across that move.

## GitHub App

Create a GitHub App with:

- Checks: read/write
- Pull requests: read/write
- Issues: read/write
- Contents: read
- Metadata: read

Pull request write access is required for the approval and rejection comments that Feature-Rec posts
to the PR conversation. If you add or increase permissions after installing the App, approve the
updated permissions on the existing installation (or reinstall the App), then restart the backend so
it mints an installation token with the new grants.

Set local env vars:

```bash
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----...'
```

Feature-Rec is driven by the GitHub Action. The backend does not consume GitHub webhooks.

For quick local testing, `FEATURE_REC_GITHUB_TOKEN` can be used as a fallback, but the intended demo path is the GitHub App.

## Slack App Setup

Create a Slack App with bot scopes:

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

Configure, replacing `<host>` with the public backend origin (or the ngrok host locally):

```text
Interactivity Request URL: https://<host>/api/slack/interactivity
Event Subscriptions Request URL: https://<host>/api/slack/events
Slash command: /feature-rec -> https://<host>/api/slack/commands
```

- Subscribe the events URL to the `member_joined_channel` bot event and
  enable **Delayed Events**: after Slack's immediate/1 min/5 min retries, delivery retries hourly
  for 24 hours, and apps below 1,000 events per hour are exempt from auto-disable, so a temporarily
  down backend cannot lose the subscription. A missed first join can be repaired automatically
  only when the bot has exactly one channel membership; otherwise use the channel command.
- On the `/feature-rec` slash command, enable **Escape channels, users, and links sent to your
  app** so channel and user mentions arrive with stable `<#C…>` and `<@U…>` ids. Plain channel
  names are intentionally not resolved.
- Reinstall the app after changing scopes. When upgrading a live install, update the Slack app
  first and deploy the service second: the new grants sit unused until the deploy, so no
  `missing_scope` window exists. If deployed backwards, `missing_scope` surfaces through the same
  check-run error path until the reinstall happens.

Set local env vars:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Interactivity, events, and commands all use the same signing secret; no other environment
variables are needed. Finally, invite the bot to the review channel. Never invite it to an
externally shared (Slack Connect) channel: validation videos and PR information would be visible
to the external organization.

## Demo Repo Setup

Copy `examples/feature-rec-workflow.yaml` to `.github/workflows/feature-rec.yaml`.

Set the LLM secret used by the action:

```text
ANTHROPIC_API_KEY=...
```

Without `ANTHROPIC_API_KEY`, Feature-Rec only auto-accepts diffs that do not look frontend-visible. To use the conservative filename-based fallback for frontend-looking diffs, set `FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1`.

Set branch protection to require the `Feature-Rec` Check Run, not the GitHub Actions workflow job.

Teams that previously restricted approvers through the removed YAML config run
`/feature-rec approvers @<usergroup>` once in the review channel; until then, approval falls open
to everyone in the channel, not closed.

## Smoke Checks

Run:

```bash
pnpm typecheck
pnpm feature-rec:selftest
pnpm --filter @autodemo/cli exec tsx scripts/validate-selftest.mts
```

In a staging Slack workspace, also verify that the first join gets one greeting and later joins are
silent; switch from a DM and confirm there is one ephemeral reply and no channel-visible post;
confirm each channel's mention mode and approvers survive the switch; exercise `mention approvers`,
`mention off`, and a custom audience; reject a mention or approver whose usergroup contains a
non-member; and remove the selected channel to confirm delivery fails without moving to another
membership, then re-invite it and confirm delivery resumes.
