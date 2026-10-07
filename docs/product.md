# How Feature-Rec works

This is the canonical description of Feature-Rec's behavior. It covers the current release, after
the deploy-D contract of the
[OIDC and multitenancy plan](plans/feature-rec-oidc-multitenancy-plan.md). Procedures live
elsewhere: [Onboarding a tenant](tenant-onboarding.md) brings a customer onto the hosted service,
and [Operations](operations.md) covers the GitHub and Slack apps and running, deploying and rolling
back the backend.

## Overview

Feature-Rec adds a product-validation step to pull requests. When a PR changes something users can
see, a GitHub Action renders a short demo video of the change and the backend posts it to the
customer's Slack review channel with `Good to merge` and `Needs changes` buttons. The `Feature-Rec`
Check Run on the PR stays pending until someone decides, so a branch-protection rule can block the
merge until the change is validated. PRs without a frontend-visible change are accepted
automatically.

Three parts cooperate:

- The **GitHub Action** ([`packages/action`](../packages/action)) runs in the customer's workflow.
  It classifies the diff, renders the video and reports to the backend.
- The **backend** ([`packages/service`](../packages/service)) authenticates every workflow call with
  GitHub Actions OIDC, keeps review state in PostgreSQL, calls GitHub through the Feature-Rec GitHub
  App, and calls Slack with the bot token of the customer's workspace.
- The **renderer** ([`packages/cli`](../packages/cli) and [`packages/video`](../packages/video))
  recreates the changed UI source as Remotion scenes. It also runs locally on bundled fixtures; see
  the [README quickstart](../README.md#quickstart).

There is no repository configuration file; legacy `.github/feature-rec-config.yaml` files are
ignored and can be deleted. Review-channel settings are changed in Slack with
[slash commands](#slash-commands). The backend does not consume GitHub webhooks: work starts only
when the action calls it.

## Review lifecycle

A review cycle belongs to one PR head commit. Its identity is the tenant, the GitHub repository ID,
the PR number and the head SHA, so renaming or transferring a repository never mixes cycles. A cycle
is in one of the statuses `analyzing`, `pending_validation`, `accepted`, `rejected`, `superseded` or
`failed`.

1. **Trigger.** The workflow runs for `pull_request` events of type `opened`, `ready_for_review` and
   `synchronize`. The action skips closed and draft PRs and every other event action, and the
   backend accepts only OIDC tokens issued for `pull_request` workflow runs.
2. **Start.** The action sends only the PR number and head SHA. The backend verifies the OIDC
   token, resolves the tenant from the token's repository owner, mints a GitHub token scoped to the
   token's repository, and reads the PR from GitHub. A closed PR, a draft, or a head that has moved
   on makes the start a clean no-op (`closed`, `draft` or `stale_head`) without a check run. The PR
   title and author always come from GitHub, never from the request.
3. **Ownership.** A new head creates a cycle in `analyzing`, creates the `Feature-Rec` check run and
   returns an attempt token that every later call for the cycle must carry. A second start for the
   same head exits as a duplicate before doing any work. A start for a head whose cycle `failed`
   takes that cycle over with a fresh attempt token and reuses its check run, so rerunning the
   workflow turns a red check back to in progress.
4. **Supersession.** A new head supersedes the PR's `analyzing` and `pending_validation` cycles:
   they become `superseded`, their check runs conclude `neutral`, and their Slack messages lose
   their buttons. Starts for the same PR are serialized, so at most one head is active.
5. **Classification.** The action decides whether the diff is frontend-visible; see
   [Change classification](#change-classification). If it is not, the cycle becomes `accepted` and
   the check succeeds with the classifier's reasoning.
6. **Channel pre-check.** For a frontend-visible change, the start response already told the action
   whether the tenant has a usable review channel. If it has none, the run fails with
   `Invite @Feature-Rec to your Slack review channel, then re-run.` before spending time on
   rendering. This check is advisory; delivery resolves the channel again.
7. **Video delivery.** The action renders the [demo video](#demo-videos) and uploads it. The cycle
   moves to `pending_validation`, the check shows `Feature-Rec: pending validation`, and the video
   and a validation message are posted to the tenant's [review channel](#channel-routing).
8. **Decision.** `Good to merge` makes the cycle `accepted`, comments on the PR and passes the
   check. `Needs changes` collects required feedback in a modal, makes the cycle `rejected`, posts
   the feedback on the PR and concludes the check as `action_required`. Either way the Slack message
   is updated to show the outcome without buttons. See
   [Slack validation and approval](#slack-validation-and-approval).

The example workflow also cancels its own in-progress run when a newer commit arrives on the same
PR.

## Change classification

With `ANTHROPIC_API_KEY` set in the workflow, the action asks Claude whether the PR contains a
frontend-visible change worth validating. It sends the PR title, the changed file list and the diff
(80 lines of context, truncated to 80,000 characters).

- Not frontend-visible, and therefore auto-accepted: backend-only, environment-only, docs-only,
  tests-only, dependency-only, lockfile-only and CI-only changes.
- Frontend-visible: UI, UX, copy, layout, styling, route, visual-state and frontend user-flow
  changes.

The classifier also names the files that carry the visible change; the renderer prefers those
within the limits described in [Demo videos](#demo-videos).

Without `ANTHROPIC_API_KEY`, a filename heuristic runs instead. Frontend candidates are `.tsx`,
`.jsx`, `.css` and `.scss` files, plus `.ts` and `.js` files inside a directory named `app`,
`pages`, `components` or `ui`; files containing `.test.`, `.spec.` or `.stories.` never count. A
diff without candidates is auto-accepted. A diff with candidates fails the run with a request for
the key, unless `FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1` treats it as frontend-visible. Rendering
also needs the key (see [Demo videos](#demo-videos)), so in practice every repository whose PRs need
review must provide it. The workflow settings are listed in
[Add the workflow](tenant-onboarding.md#add-the-workflow).

## Demo videos

The renderer considers only the first three changed `.tsx` or `.jsx` files in path order, skipping
test, spec and story files. Files the PR deletes are dropped after that cut, and the classifier's
named files are preferred only among those three; when it names none of them, all are used. Later
files are never rendered, even when the classifier names them. If nothing remains, the run fails
with `Classifier found a frontend-visible change, but Feature-Rec could not extract reproducible
TSX/JSX source.` That happens, for example, when the first three such files are all deleted, even if
a later one survives. Changes that touch only stylesheets or plain modules cannot be rendered
either.

A changed file that another selected file imports gets no scene of its own: it is shown in context
by the importing file's scene.

For each source, a Claude-based agent writes one Remotion scene with the scene kit
(`packages/video/src/kit`): the whole component framed, a light zoom only for small elements, a
macOS-style pointer, and the change animated the way a user would meet it. The UI itself comes from
one of two places:

- **Real components.** When the changed file and its local imports (relative paths and tsconfig
  aliases) only use React, `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`,
  `next/link` or `next/image`, the before and after files are read at the PR's base and head
  commits and rendered untouched, so the UI is exactly the code's. The pointer's clicks are real DOM
  clicks on those components, and their own CSS transitions are replayed frame by frame.
- **Reconstruction.** Otherwise the agent rebuilds the UI from the diff.

The repository's Tailwind theme (`tailwind.config` colors, radii, fonts…) and the CSS variables of
its global stylesheet are injected into the renderer; if the renderer cannot compile them, the video
is rendered again without them. The target application is never built or launched, but in real mode
its component code runs inside the render browser, where network access is blocked (`fetch`, XHR,
WebSocket, beacons and external images) and rendering is deterministic.

A scene is checked before rendering (scene validation, real components not retyped, TypeScript
errors in the scene); a failed check, or a failed render, is fed back to the agent for one repair
attempt. The scenes are composed into one H.264 MP4 without an audio track, which the action uploads
(up to 500 MB). Unless `upload-video` is `false`, the action also keeps the MP4, the generated scene
code and the injected theme as a workflow artifact for seven days.

Generation needs `ANTHROPIC_API_KEY`. Without it, or when generation fails, only the bundled
fixture scenes (`dark-mode-toggle` and `invite-members`) can render, and any other change fails.

## GitHub check and comments

Every cycle has one check run named `Feature-Rec` on its head commit, with the cycle key as its
external ID. The workflow job finishes while the check waits for the Slack decision, so branch
protection must require the check, not the job.

| Event | Check status | Title |
| --- | --- | --- |
| Cycle started, or a rerun took over a failed cycle | in progress | `Feature-Rec: analyzing` |
| Not frontend-visible | success | `Feature-Rec: accepted`, with the classifier verdict |
| Video sent to Slack | in progress | `Feature-Rec: pending validation` |
| `Good to merge` | success | `Feature-Rec: accepted`, linking the PR comment |
| `Needs changes` | action required | `Feature-Rec: rejected`, linking the PR comment |
| Newer head | neutral | `Feature-Rec: superseded` |
| Runner reported an error | failure | `Feature-Rec: failed`, with the error |
| Delivery failed | failure | `Feature-Rec: Slack integration unavailable`, `Feature-Rec: no Slack review channel` or `Feature-Rec: video delivery failed` |

Decisions also comment on the PR conversation, mentioning the author:

- `Good to merge`: `@<author> validation passed, you can merge.`
- `Needs changes`: `@<author> make the following changes:` followed by the reviewer's feedback.

The check name, button labels and comment templates are fixed.

## Slack validation and approval

Delivery uploads the video to the review channel as `feature-rec-<PR>-<SHA prefix>.mp4`, with the
comment `Feature-Rec video for <owner>/<repo>#<PR>`. It then posts the validation message:

- the mention line chosen by the channel's [mention setting](#slash-commands), if any;
- `Feature-Rec validation needed for <owner>/<repo>#<PR>` and the PR title;
- the first 12 characters of the head SHA;
- the buttons `Good to merge` and `Needs changes`.

The repository name is the current GitHub full name at delivery time.

Who may decide comes from the approver setting of the channel where the validation was posted, read
at click time. Without a restriction, anyone who can use the buttons may decide. With one, only the
listed users and the current members of the listed usergroups may decide; anyone else gets an
ephemeral `Only … can approve.` reply. A click must also come from the Slack workspace of the
cycle's tenant, and buttons of a cycle that is no longer pending, or of an older head, do nothing.
Repeated clicks are deduplicated, and when two decisions race, the first one wins.

- **Good to merge** first re-checks that the GitHub App can still access the repository. If it
  cannot, the cycle stays pending and the clicker gets an ephemeral explanation.
- **Needs changes** opens a modal with a required comment; an empty comment is refused with
  `Please describe what needs to change.` Submitting re-runs the approver, workspace and GitHub
  access checks within two seconds. On an error or timeout the modal shows the error and keeps the
  comment for a retry, and a check that finishes late changes nothing.

After a decision, supersession or failure, the message is replaced by `Feature-Rec: <outcome>` with
a detail line (`Validation passed.`, the reviewer's feedback, `A newer commit started a fresh
validation cycle.`, or the failure message) and the head SHA, without buttons. Finalized messages
identify the PR by number only, so they can be updated even after GitHub access is gone.

## Channel routing

All repositories of a tenant share the one review channel selected for its Slack workspace.

- **Selection.** After provisioning, the first channel the bot joins becomes the selection and
  receives the greeting
  ``Connected. Use `/feature-rec channel`, `mention`, `approvers`, or `status` — see `/feature-rec help`.``
  Later joins are silent. Anyone in the workspace can select another channel the bot belongs to
  with `/feature-rec channel #channel-name`, and operators can set it when
  [provisioning](tenant-onboarding.md#provision-the-tenant). Joins that happen before the workspace
  is provisioned are not recorded.
- **Missed joins.** If nothing is selected when a validation is ready and the bot is in exactly one
  channel, delivery selects that channel and greets it. With several memberships it refuses to
  guess and asks for `/feature-rec channel #channel-name`.
- **Availability.** The selection is checked against the bot's live Slack membership whenever a
  validation is posted. If the bot was removed from the selected channel, nothing is posted, no
  other channel is promoted, and the check fails with instructions to invite the bot back or select
  another channel. The selection is kept, so re-inviting the bot resumes delivery there.
- **Shared channels.** Membership is honored exactly as Slack reports it, with no shared-channel
  filtering. **Do not invite `@Feature-Rec` to externally shared (Slack Connect) channels**:
  validation videos and PR information would be visible to the external organization.

The selection is stored on the tenant's Slack workspace (`slack_workspaces.selected_channel_id`).
Each channel keeps its own mention mode, custom mention audience and approver list in
`channel_settings`; switching channels restores the target's settings without copying them. A
never-configured channel uses virtual defaults (mentions follow approvers, anyone may approve)
without storing a row. Bot membership is read live from Slack and never persisted.

## Slash commands

`/feature-rec` works from any conversation or DM in an installed workspace, and every reply is
ephemeral. Setting commands always read and update the selected review channel, not the conversation
where they run. `/feature-rec`, `/feature-rec help` and unknown subcommands return the general help.
In a workspace that is not provisioned, or whose tenant is disabled, every command answers
`Feature-Rec is not enabled for this Slack workspace.`

| Command | Effect |
| --- | --- |
| `/feature-rec channel` | Show the selected review channel and whether the bot is still in it. |
| `/feature-rec channel #channel-name` | Select a public or private channel the bot has joined. The target must be an escaped Slack channel mention. Switching restores that channel's settings, or the defaults, without copying or rewriting them. |
| `/feature-rec mention` | Show the channel's notification setting and usage. |
| `/feature-rec mention approvers` | Mention the channel's current approvers whenever a validation is posted. This is the default; with unrestricted approval it mentions `@channel`. |
| `/feature-rec mention off` | Post validation requests without mentioning anyone. |
| `/feature-rec mention @here\|@channel\|@usergroup\|@user…` | Mention a custom audience, independent of later approver changes. `@channel` must be alone; `@here` may be combined with users or usergroups. |
| `/feature-rec approvers` | Show who may approve and usage. |
| `/feature-rec approvers @channel\|@usergroup\|@user…` | Restrict who may use the decision buttons to the listed users and usergroup members. `@channel`, alone, removes the restriction. The default is anyone in the channel. |
| `/feature-rec status` | Show the selected channel, its availability, and the approval and notification summary. |

Saving a custom mention or approver list requires every listed user, and every member of each
listed usergroup, to belong to the selected channel; the reply names up to five missing members.
Usergroups are matched by handle or escaped mention, disabled usergroups are ignored, and empty
usergroups are rejected. `@here` and `@channel` need no membership check. Membership is checked only
when a setting is saved: later membership changes do not rewrite stored settings or block delivery,
and switching channels does not revalidate them. Settings can be changed only while the bot is in
the selected channel, and a command that races with a channel switch asks the user to try again.

Teams that restricted approvers through the removed YAML configuration run
`/feature-rec approvers @<usergroup>` once; until then, anyone in the channel can approve.

## Tenants and isolation

A tenant is the customer boundary. It owns exactly one GitHub App installation, on a GitHub
organization or user account, and exactly one Slack workspace. Neither the GitHub account nor the
Slack workspace can belong to a second tenant. A tenant may use every repository that its
installation grants; provisioning checks one repository end to end but does not restrict the tenant
to it.

Every request is bound to a tenant through verified identities only:

```text
GitHub Actions OIDC token (audience: the backend's public URL, event: pull_request)
-> repository_owner_id -> the tenant's GitHub installation -> enabled tenant
-> repository_id -> GitHub token scoped to that repository, minted for this operation
tenant -> its Slack workspace -> that workspace's encrypted bot token
```

- **Runner calls.** The action requests a fresh OIDC token for every backend call, including the
  calls made after long rendering. No shared secret exists, and request bodies never carry tenant or
  repository identity. Every call after the start must match the cycle's tenant and repository and
  carry its attempt token.
- **GitHub access.** Each logical operation mints a fresh installation token restricted to the one
  repository ID and checks the repository and owner IDs GitHub returns. Tokens and repository
  metadata are never cached, so renames need no data change or restart, and removing a repository
  from the installation, or uninstalling the App, stops further work on it.
- **Slack access.** Each workspace's bot token is stored encrypted, bound to its workspace ID, and
  never logged. Slack requests are verified with the app signing secret and routed by the signed
  workspace ID to an enabled tenant, with no fallback to another workspace. A decision must come
  from the workspace of the cycle's tenant.
- **Slack uninstall.** A verified uninstall or token revocation deletes that workspace's credential,
  channel selection and channel settings and disables its tenant. Review history and the GitHub
  installation remain, and other tenants are unaffected. Resuming requires reinstalling and
  re-provisioning; see [Change or remove a tenant](tenant-onboarding.md#change-or-remove-a-tenant).
  How events are verified is described in
  [Slack lifecycle events](operations.md#slack-lifecycle-events).

Tenants are created and paired by an operator; see [Onboarding a tenant](tenant-onboarding.md).

## Failure behavior

Runner requests answer with:

| Response | Meaning |
| --- | --- |
| `401` | The OIDC token is missing, invalid or expired, was not issued for a `pull_request` run, or its audience is not the backend's public URL. The service logs a safe reason category. |
| `403` | The tenant is unknown or disabled, or its GitHub App installation does not grant the repository. The response never reveals which. |
| `503` with `Retry-After` | GitHub Actions OIDC or GitHub is temporarily unavailable or rate limited. `Retry-After` is at least 10 seconds, and 60 seconds for a GitHub secondary rate limit without a provider delay. |
| `502` | GitHub rejected a request permanently. |
| `{"ok": false, "stale": true}` | The attempt no longer owns the cycle (superseded, decided or taken over); nothing changed. |

- OIDC verification, repository authorization and PR reads are attempted up to three times on
  transient failures; endpoints that change state are never replayed as a whole. Each GitHub
  request times out after five seconds.
- The OIDC token is verified when a request arrives, before its body is read, so a token that
  expires during a long video upload does not invalidate the upload. Tenant and repository
  authorization run after the body is buffered, just before any state change.
- When the action fails while processing, it reports the error, which fails the check. If that
  report also fails, the action keeps the original error.
- Once the backend owns a video upload, any delivery error marks the cycle `failed`. Workspace and
  channel problems keep their specific messages; unexpected failures use a generic message, with
  details in the service logs. The check update and the cleanup of any posted Slack message then
  run independently with bounded retries. The response carries `settled: true`, meaning the cycle
  is failed even if cleanup could not finish; the action does not report it again, and rerunning
  the workflow takes over the failed cycle. Concurrent decisions and supersessions are preserved.
  Cleanup reuses the upload request's GitHub token while more than 60 seconds of its validity
  remain, leaving time for the bounded check retries, and mints a fresh one otherwise. Reuse saves
  a token request but does not refresh installation status or repository metadata during delivery.
- If GitHub access fails when `Good to merge` is clicked, the cycle stays pending and the clicker is
  told ephemerally.
- After a decision the database transition comes first; GitHub and Slack updates then run
  independently, so one provider's outage cannot block the other. PR comments are posted once and
  never retried, to avoid duplicates; check and Slack message updates retry up to three times.
- There is no durable outbox. A database outage or process crash between a state change and its
  provider updates can leave a check or Slack message out of date. If one interrupts a video
  upload after the cycle became `pending_validation` but before the validation was posted or the
  failure recorded, the cycle stays pending without a Slack message and rerunning the workflow
  exits as a duplicate; pushing a new commit supersedes it.

## Limits and non-goals

- One GitHub account and one Slack workspace per tenant, and one review channel per workspace.
  Sharing a workspace or account between tenants is not supported.
- Only GitHub.com Actions OIDC for `pull_request` workflows. A custom issuer is a configuration
  seam, not GitHub Enterprise Server support.
- Rendering covers only the first three changed `.tsx` or `.jsx` files in path order and needs
  `ANTHROPIC_API_KEY`; see [Demo videos](#demo-videos).
- Slack Enterprise Grid organization installs and Slack token rotation are not supported.
- No GitHub webhooks: installation and repository changes take effect at the next authorization.
- No self-serve signup or onboarding UI; onboarding is operator-assisted, and workflows are added
  by hand.

## Related documentation

- [Onboarding a tenant](tenant-onboarding.md): bring a customer onto the hosted service.
- [Operations](operations.md): maintain the GitHub and Slack apps, and run, deploy, administer and
  roll back the backend.
- [README](../README.md): repository structure, local rendering and development checks.
- [Multitenancy notes](multitenancy-notes.md): historical single-tenant design notes.
- [Design and rollout plans](plans/): decisions and release history.
