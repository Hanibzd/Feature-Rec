# Onboarding a tenant

This procedure brings a new customer (a tenant) onto a hosted Feature-Rec deployment. The customer's
GitHub and Slack administrators install the apps and add the workflow; the Feature-Rec operator
pairs and activates the tenant with the compiled admin command. It describes the release after the
deploy-D contract: workflows authenticate with GitHub Actions OIDC, Slack is installed through the
hosted OAuth page, and there is no runner secret or repository configuration file.

What the product does once a tenant is live is described in
[How Feature-Rec works](product.md). Registering the GitHub and Slack apps, configuring and running
the backend, and the admin command itself are covered in [Operations](operations.md).

## Before you start

The operator needs:

- a running hosted backend with the GitHub App and Slack app registered, as described in
  [Platform setup](operations.md#platform-setup);
- hosted Slack OAuth enabled, as described in
  [Hosted Slack OAuth configuration](operations.md#hosted-slack-oauth-configuration);
- access to run the compiled admin command in the production environment, as described in
  [Administration commands](operations.md#administration-commands).

The customer needs:

- a GitHub administrator who can install a GitHub App on their organization or user account;
- someone allowed to install apps in exactly one Slack workspace;
- a public or private Slack channel for reviews that is not shared with another organization;
- an Anthropic API key for the repositories' workflows.

A tenant pairs exactly one GitHub account with exactly one Slack workspace, and neither can belong
to another tenant. Collect these values during onboarding:

| Value | Where it comes from |
| --- | --- |
| GitHub installation ID | [Install the GitHub App](#install-the-github-app) |
| One repository, as `owner/repo` | A repository the installation grants, used for the end-to-end check |
| Slack installation ID and workspace ID | The completion page of [Install the Slack app](#install-the-slack-app) |
| Review channel ID | Slack channel details, at the bottom of the **About** tab |

## Install the GitHub App

1. The customer installs the Feature-Rec GitHub App on their organization or user account and
   grants the repositories that will use Feature-Rec. Every repository the installation grants,
   now or later, works without re-provisioning; repositories it does not grant are refused.
2. The customer sends the installation ID to the operator. It is the number at the end of the
   installation's **Configure** page URL, `…/settings/installations/<installation-id>`.

## Install the Slack app

1. Open the deployment's fixed start URL, `<backend>/api/slack/oauth/start` (for the hosted service,
   `https://api.feature-rec.com/api/slack/oauth/start`), in a browser. It redirects straight to
   Slack; there is no invitation, app login or landing page. Use one tab: a session lasts ten
   minutes, and an interrupted or second attempt needs a fresh start.
2. Select the customer's workspace and approve. Installing across a whole Enterprise Grid
   organization is not supported.
3. The completion page reads `Slack app installed. Feature-Rec activation is pending operator
   provisioning.` and shows an **Installation ID** and a **Workspace ID**. Send both to the
   operator. Nothing is active yet: the bot token is stored encrypted as a pending installation and
   cannot be used until the operator provisions it. If the page instead says
   `Slack installation could not be completed. Start again at /api/slack/oauth/start.`, start again.
4. Invite `@Feature-Rec` to the review channel, for example with `/invite @Feature-Rec` in that
   channel, and send the channel ID to the operator. Joins before provisioning are not recorded, so
   the operator selects the channel when provisioning. Never use an externally shared (Slack
   Connect) channel; see [Channel routing](product.md#channel-routing).

Pending installations do not expire. The operator should confirm the workspace ID with the customer
before provisioning, and [cancel](#change-or-remove-a-tenant) installations that will not be used.

## Provision the tenant

The operator activates the tenant from the production service:

```bash
railway ssh -- node dist/admin.js provision-tenant --environment production --confirm \
  --slack-installation-id <Slack-installation-id> \
  --installation-id <GitHub-installation-id> --repository <owner/repo> \
  --selected-channel-id <Slack-channel-id>
```

Before writing anything, the command:

- decrypts the pending installation and checks with Slack's `auth.test` that the token still
  belongs to the same workspace and bot, so an installation that was removed or revoked at Slack
  cannot be activated;
- checks that the bot is a member of the selected channel;
- checks that the repository belongs to the GitHub installation and that the App can mint a token
  scoped to that repository.

It then creates the tenant, or reuses the one that already owns these integrations, stores the
exact validated encrypted token, records the GitHub installation, enables the tenant and marks the
pending installation consumed, all in one transaction. It prints a JSON report with `tenantId`,
`slackTeamId`, `githubInstallationId`, `githubAccountId`, `repositoryId`, `selectedChannelId` and
`replacedPairings`. Record the `tenantId` with the customer's details.

- `--repository` is only the end-to-end check; it does not limit the tenant to that repository.
- Without `--selected-channel-id`, an existing selection for the workspace is kept. Otherwise a
  channel is selected later: by the bot's next channel join, by `/feature-rec channel`, or when the
  first validation finds the bot in exactly one channel.
- Pass `--tenant-id <uuid>` when re-provisioning a known tenant; a new tenant gets a generated ID.
- The command refuses to move an integration that belongs to another tenant; see
  [Change or remove a tenant](#change-or-remove-a-tenant).
- On this path the command never prompts for or prints a token. A provider check failure is
  reported as a fixed message naming Slack or GitHub, without provider details.
- If the response is lost, the status command shows whether the installation was consumed, and
  for which tenant and GitHub installation:

  ```bash
  railway ssh -- node dist/admin.js slack-installation-status --environment production \
    --slack-installation-id <Slack-installation-id>
  ```

For a local backend, build the admin entrypoint and load the local environment instead:

```bash
pnpm --filter @feature-rec/service run build
```

```bash
node --env-file=.env packages/service/dist/admin.js provision-tenant \
  --environment development --confirm --slack-installation-id <Slack-installation-id> \
  --installation-id <GitHub-installation-id> --repository <owner/repo> \
  --selected-channel-id <Slack-channel-id>
```

## Add the workflow

In each repository that should use Feature-Rec:

1. Copy [`examples/feature-rec-workflow.yaml`](../examples/feature-rec-workflow.yaml) to
   `.github/workflows/feature-rec.yaml`. It runs for `opened`, `ready_for_review` and `synchronize`
   events on open, non-draft PRs; grants `contents: read`, `pull-requests: read` and
   `id-token: write`; checks out the full history, which the diff needs; and cancels a PR's
   in-progress run when a newer commit arrives.
2. Pin the action. The example references `Hanibzd/Feature-Rec/packages/action@main`; replace `main`
   with a tested release tag or commit SHA so that changes to the action reach the repository only
   when you update the pin.
3. Add an `ANTHROPIC_API_KEY` repository or organization secret. The example passes it to the
   action, which needs it for every PR that requires review.
4. Leave the action's `api-url` input unset for the hosted service; it defaults to
   `https://api.feature-rec.com`. A self-hosted backend sets `api-url` to its public origin, which
   must equal the backend's `FEATURE_REC_BASE_URL` because it is the OIDC audience.
5. Remove any old `FEATURE_REC_RUNNER_TOKEN` secret or reference; no shared runner secret is used.
6. Require the `Feature-Rec` status check in the branch protection rule or ruleset. Require the
   check, not the workflow job (`Analyze and render`): the job finishes while the check waits for
   the Slack decision.

Optional environment variables for the action step:

| Variable | Effect |
| --- | --- |
| `FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1` | Without `ANTHROPIC_API_KEY`, treat filename-heuristic frontend candidates as frontend-visible instead of failing. Rendering still needs the key. |
| `FEATURE_REC_MODEL` | Claude model for classification; defaults to `AUTODEMO_MODEL`, then `claude-sonnet-4-6`. |
| `AUTODEMO_MODEL` | Claude model for scene generation; defaults to `claude-sonnet-4-6`. |
| `AUTODEMO_MAX_TOKENS` | Output token limit for scene generation; defaults to 16,000. |

The classification and rendering rules are described in
[Change classification](product.md#change-classification) and [Demo videos](product.md#demo-videos).

## Configure the review channel

From any conversation in the workspace:

1. Run `/feature-rec status`. It shows the selected review channel, whether the bot is in it, and
   the channel's approval and notification settings.
2. If no channel is selected, run `/feature-rec channel #review-channel`.
3. To restrict who may approve, run `/feature-rec approvers @usergroup`. By default anyone in the
   channel may approve, and validation requests mention the approvers, or `@channel` when approval
   is unrestricted.

All commands and their rules are listed in [Slash commands](product.md#slash-commands).

## Verify the first review

1. Open a PR in a provisioned repository that changes a `.tsx` or `.jsx` component visibly.
2. Confirm that the `Feature-Rec` check shows `Feature-Rec: analyzing`, then
   `Feature-Rec: pending validation`, and that the video and validation message reach the review
   channel.
3. Click `Good to merge`. The PR gets the approval comment, the check succeeds, and the Slack
   message loses its buttons.
4. Optionally, open a docs-only PR and confirm that the check succeeds without a Slack post.

If anything fails, see [Troubleshooting](#troubleshooting).

## Change or remove a tenant

- **Replace the Slack token or reinstall the app in the same workspace.** The customer opens the
  start URL again; the new pending installation does not affect the active credential. Provision
  it with `--slack-installation-id`, the tenant's `--tenant-id` and its GitHub installation and
  repository. The workspace keeps its channel selection and settings.
- **Reinstall the GitHub App on the same account.** Provisioning always needs a Slack credential,
  so the customer also opens the Slack start URL again. Provision the new pending installation
  with the new GitHub installation ID and the tenant's `--tenant-id`; the old installation record
  is replaced.
- **Move a workspace or GitHub account to another tenant.** Provisioning refuses with
  `Provisioning would re-pair existing integrations: …` or
  `Slack and GitHub integrations are paired to different tenants`. After confirming ownership with
  both customers, rerun it with `--replace-pairing`. The report lists the replaced pairings. Every
  tenant that loses an integration is disabled. A Slack workspace previously paired with the target
  tenant is removed together with its channel settings, while a workspace that moves keeps its
  selection and settings.
- **Slack app uninstalled or token revoked.** Feature-Rec verifies the event with Slack, then
  deletes the workspace's credential, channel selection and channel settings and disables the
  tenant. To resume, reinstall through the start URL, provision again with the tenant's
  `--tenant-id`, then reselect the channel and reapply its settings.
- **GitHub App uninstalled or repository removed from it.** Workflow calls for the affected
  repositories fail with `403`. Restore the grant; if the App was reinstalled, provision it as for
  a GitHub App reinstall above.
- **Abandoned installation.** Cancel a pending installation that will not be provisioned:

  ```bash
  railway ssh -- node dist/admin.js cancel-slack-installation --environment production \
    --confirm --slack-installation-id <Slack-installation-id>
  ```

  Cancellation clears Feature-Rec's staged credential but does not revoke the token at Slack;
  uninstall the app from the workspace for that. Status and cancellation need only database access,
  so they work even when provider credentials or the encryption key are unavailable.

No admin command deletes or disables a tenant directly. Tenant records and review history are kept.

## Manual token provisioning

Reserve this path for migration, testing and emergency recovery; normal onboarding uses the hosted
OAuth installation. Omit `--slack-installation-id`, and the command reads the Slack bot token from a
non-echoing terminal prompt, or from stdin when it is not a terminal:

```bash
railway ssh -- node dist/admin.js provision-tenant --environment production --confirm \
  --installation-id <GitHub-installation-id> --repository <owner/repo> \
  --selected-channel-id <Slack-channel-id>
```

Never pass a token as a command-line argument. The command runs the same Slack and GitHub checks,
encrypts the token itself, and reports provider errors as they occur.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The workflow fails with `Could not obtain GitHub Actions OIDC token` | The job lacks `permissions: id-token: write`. Add it. |
| A backend call fails with `401` | The action's `api-url` does not match the backend's `FEATURE_REC_BASE_URL`, or the workflow was not triggered by `pull_request`. |
| A backend call fails with `403` | The tenant is not provisioned or is disabled, or its GitHub App installation does not grant the repository. Provision the tenant or grant the repository. |
| `ANTHROPIC_API_KEY is required to classify frontend-visible changes` | Add the secret; see [Add the workflow](#add-the-workflow). |
| `Invite @Feature-Rec to your Slack review channel, then re-run.` | No usable review channel: the bot is in no channel, was removed from the selected channel, or is in several channels with none selected. Invite the bot or run `/feature-rec channel #channel-name`, then rerun the workflow. |
| `Feature-Rec is present in multiple channels…` | Run `/feature-rec channel #channel-name`, then rerun the workflow. |
| `Feature-Rec is not currently in the selected review channel…` | Invite the bot back or select another channel, then rerun the workflow. |
| The check shows `Feature-Rec: Slack integration unavailable` | The Slack app was uninstalled or its token revoked. Reinstall and provision again. |
| Slash commands answer `Feature-Rec is not enabled for this Slack workspace.` | The workspace is not provisioned, or its tenant is disabled. |
| A click answers `Only … can approve.` | The clicker is not an approver; see `/feature-rec approvers`. |
| A click answers `Feature-Rec no longer has access to this repository…` | Restore the GitHub App installation's access to the repository, then click again. |
| Provisioning fails with `The Slack bot is not a member of the selected channel` | Invite `@Feature-Rec` to that channel first. |
| Provisioning fails with `Pending Slack installation is unavailable` | The installation was consumed, cancelled or never completed. Check its status, or start again at the start URL. |
| Provisioning fails with `Pending Slack installation does not match the live Slack workspace and bot` | The app was reinstalled or removed since the pending installation was created. Start again at the start URL. |
| The check stays in progress without a Slack message, and rerunning the workflow exits as a duplicate | An outage or crash interrupted delivery before the validation was posted or the failure recorded. Push a new commit to start a fresh cycle. |
| Service logs show `SLACK_TOKEN_DECRYPTION_FAILED` for a tenant | Provision that tenant's Slack credentials again; see [Slack token encryption](operations.md#slack-token-encryption). |

A failed cycle is retried by rerunning the workflow: the next run takes the cycle over.
