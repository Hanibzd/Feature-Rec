# Feature-Rec

Feature-Rec turns frontend-visible pull request changes into a Slack approval flow.
Its GitHub Action classifies the diff, renders a short UI demo when product review
is needed, and keeps the `Feature-Rec` Check Run pending until a reviewer chooses
`Good to merge` or submits feedback through `Needs changes`. Backend-only,
docs-only, test-only, dependency-only, and CI-only changes are auto-accepted.

The renderer recreates changed UI source as Remotion components and produces a
deterministic, silent MP4 without launching the target application. It also runs
locally on bundled fixtures or git diffs.

[How Feature-Rec works](docs/product.md) is the canonical description of the review flow,
Slack commands and tenant isolation. [Onboarding a tenant](docs/tenant-onboarding.md)
brings a customer onto the hosted service, and [Operations](docs/operations.md) covers the
GitHub and Slack apps, running and deploying the backend, administration, and rollback.

## Repository structure

This is a pnpm monorepo:

| Path | Purpose |
| --- | --- |
| `packages/action` | GitHub Action: PR events, diff classification, renderer invocation, and backend calls. |
| `packages/service` | Fastify backend: Slack review, GitHub Checks/comments, tenant administration, and PostgreSQL state. |
| `packages/core` | Shared schemas, action/service contracts, copy constants, and helpers. |
| `packages/llm` | Provider-agnostic LLM client for the action classifier and the scene agent; not part of the backend image. |
| `packages/cli` | Analyze, generate scenes, render video, and write local release artifacts. |
| `packages/video` | Remotion compositions and scenes used by the renderer. |
| `fixtures` | Before/after UI examples for local demos. |
| `examples` | Consumer GitHub Actions workflow. |

## Quickstart

Requirements:

- Node.js 24 and pnpm 11.9.0, as specified in `package.json`.
- Docker for the Makefile-managed backend and PostgreSQL tests.
- GitHub CLI only when posting generated PR comments with `--post`.

From the repository root:

```bash
pnpm install
pnpm run demo --offline
```

The demo uses the bundled known-good scenes without an LLM key and writes
`out/demo.mp4`, `out/CHANGELOG.md`, `out/pr-comment.md`, and `out/plan.json`.
`--offline` skips AI generation; rendering may still need browser/font downloads.
To use live scene generation, export an LLM key and omit `--offline`; see
[LLM providers](#llm-providers).

For a single fixture or an interactive preview:

```bash
pnpm run demo --offline --feature invite-members
pnpm run studio
```

To run the complete GitHub-to-Slack review flow, follow the
[local backend setup](docs/operations.md#local-backend) and
[onboard a test tenant](docs/tenant-onboarding.md) against it.

## LLM providers

Feature-Rec calls an LLM twice per reviewed PR: to classify the diff and to generate each Remotion
scene. It works with Anthropic, OpenAI, OpenRouter and any OpenAI-compatible API. Existing
workflows that pass only `ANTHROPIC_API_KEY` keep `claude-sonnet-4-6` with no change. The
variables and action inputs are listed in
[LLM provider settings](docs/tenant-onboarding.md#llm-provider-settings).

Scene generation asks for up to 16,000 output tokens of Remotion code and is the demanding call.
Models tested on the `dark-mode-toggle` and `invite-members` fixtures:

| Provider | Model | Scene passes validation | MP4 renders | Matches the component |
| --- | --- | --- | --- | --- |
| Anthropic | `claude-sonnet-4-6` | Reference | Reference | Reference |
| OpenAI | — | Not tested yet | Not tested yet | Not tested yet |
| OpenRouter | — | Not tested yet | Not tested yet | Not tested yet |

## Development commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm run generate --feature dark-mode-toggle` | Generate a scene and plan from a fixture. |
| `pnpm run generate --git <range>` | Generate scenes from supported UI changes in a git diff. |
| `pnpm run render` | Render the current plan to `out/demo.mp4`. |
| `pnpm run publish` | Write local changelog and PR-comment artifacts. |
| `pnpm run publish --post` | Post the generated PR comment using the GitHub CLI. |
| `pnpm run typecheck` | Type-check all workspace packages. |
| `pnpm run lint` | Run type-aware lint checks across workspace packages. |
| `make selftest` | Run all selftests with Docker-managed PostgreSQL. |
| `make selftest-service` | Run the service selftests with Docker-managed PostgreSQL. |
| `make dev` | Load `.env`, start local PostgreSQL, and run the backend. |
| `pnpm --filter @feature-rec/service run build` | Compile the backend and admin command into `packages/service/dist`. |
| `node packages/service/dist/admin.js --help` | Show the compiled administration commands. |

Use `pnpm run publish` explicitly: bare `pnpm publish` is pnpm's package-registry
command. Generation and demo commands can update tracked scenes and their registry;
inspect those diffs after local runs.

## Validation

Run the complete local application gate:

```bash
make ci
```

This runs typecheck, lint, and all selftests, starting or reusing the Docker-managed
PostgreSQL 18 instance. Service selftests use temporary databases and fake provider
clients; they do not need live GitHub or Slack credentials.

For an existing local/test database server, run `pnpm run selftest` with
`TEST_DATABASE_URL` set to a connection with create/drop-database privileges.

[CI](.github/workflows/ci.yaml) additionally builds the production image and checks
compiled admin help and `/health`. Follow the
[image build and smoke procedure](docs/operations.md#production-image)
for packaging changes and the
[integration smoke checks](docs/operations.md#smoke-checks) for live review flows.

## Further documentation

- [How Feature-Rec works](docs/product.md): review lifecycle, classification, Slack
  approval, channel routing, slash commands, tenant isolation, and failure behavior.
- [Onboarding a tenant](docs/tenant-onboarding.md): GitHub App and Slack installation,
  provisioning, the consumer workflow, and tenant changes.
- [Operations](docs/operations.md): the GitHub and Slack apps, runtime configuration, deployment,
  administration commands, migrations, rollback, and smoke checks.
- [Development agent instructions](AGENTS.md): shared working standards for coding agents.
- [Multitenancy notes](docs/multitenancy-notes.md): historical single-tenant design notes and the
  multitenancy rollout review.
- [Design and rollout plans](docs/plans/): implementation decisions and release sequencing;
  check each plan's status before treating it as current behavior.

## Roadmap

Remotion will be replaced with an in-house solution we are currently building.

make something that people want
