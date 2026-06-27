# AutoDemo vs git-glimpse

## 1. Summary

**git-glimpse** is a published GitHub Action + CLI that generates demo clips of PR UI changes by **recording the real running app**. On a PR or `/glimpse` comment it reads the diff, asks Claude to write a Playwright `demo(page)` script, runs it in headless Chromium with video recording, converts the `.webm` to GIF/MP4/WebM via FFmpeg, and posts (or updates) a PR comment with the media inline. It is event-driven and falls back to static screenshots if recording fails.

**AutoDemo** is a CLI/monorepo that turns a UI diff into a branded animated MP4 by **reproducing the changed component 1:1 as Remotion (React) components** — it never runs the app. For each changed component (before/after source + design tokens + PR metadata) Claude emits a self-contained Remotion scene that re-creates the markup with the source's exact Tailwind classes and animates only the new "hero" element, wrapped in a branded intro/outro and rendered to a muted 1920×1080 H.264 MP4.

**Fundamental divergence:** git-glimpse *captures* what the browser actually renders (fidelity bounded by what the app can display); AutoDemo *generates* the UI from code (fidelity bounded by how well the LLM re-creates it, but with full cinematic control and no need to boot the app). One is capture-based and CI-wired today; the other is reproduction-based and currently manual-only.

## 2. Side-by-side

| Dimension | git-glimpse | AutoDemo |
|---|---|---|
| **Approach** | LLM-written Playwright script records the real app | LLM reproduces changed UI 1:1 as Remotion scenes |
| **Trigger** | GitHub Action on `pull_request` / `issue_comment` + `/glimpse` commands; also `npx git-glimpse run` | Manual only (`pnpm demo/generate/render/publish`); CI "Not wired yet" |
| **Output** | GIF (default), MP4, or WebM; posted inline in PR comment, hosted via GitHub | MP4 only (1920×1080@30, muted); written to `out/`, referenced as local path in `pr-comment.md` |
| **Fidelity method** | Real browser capture (verbatim, incl. data/3rd-party widgets) | Code reproduction via exact Tailwind classNames; cinematic Camera/Spotlight/Caption |
| **Maturity** | Public repo (5★, 0 forks, 16 issues, v0.1.0, AGPL-3.0); ~22 tests, 3 Vitest configs, CI, README ~570 lines | Hackathon MVP v0.1.0, private, not a git repo; 1 self-test script, no CI/license, README ~407 lines |

## 3. What git-glimpse does that AutoDemo doesn't

### High relevance

**Published, versioned GitHub Action** — git-glimpse ships a node20 `action.yml` at root, consumable as `DeDuckProject/git-glimpse@v1`. AutoDemo has no `.github` dir; README self-declares the Action "Not wired yet." *Idea:* add a thin composite Action that checks out the PR and runs `pnpm generate --git <base>...<head>` + `render` + `publish --post`, uploading `out/demo.mp4` via `actions/upload-artifact`. Remotion's render (incl. its ~90MB headless Chrome) runs fine in CI.

**Event-driven triggering** (`pull_request` opened/synchronize, `issue_comment`) — the action reads the PR diff from the event. AutoDemo runs only via Commander scripts. *Idea:* wire `on: pull_request` and pass PR base/head SHAs into AutoDemo's existing `--git <range>` flag; `featuresFromGit` already resolves before/after via `git show`.

**On-demand comment commands** (`/glimpse`, `--force`, `--route`) via `parseGlimpseCommand`. AutoDemo never reads comments (`publish.ts` only posts). *Idea:* add an `issue_comment` trigger that greps for `/autodemo` + flags and maps them onto existing `--feature`/`--git` flags.

**CI-native media hosting + inline embedding** — git-glimpse uploads to a draft-release asset (`browser_download_url`) and/or Actions artifact and embeds `![Demo](url)` (GIF auto-animates inline) plus an "open directly" fallback link. AutoDemo's `pr-comment.md` references a local `out/demo.mp4` path that isn't viewable from a posted comment. *Idea:* after render, upload the MP4 (reuse the `gh`/Octokit dependency for the draft-release trick or `upload-artifact`), rewrite the comment URL, and **also emit a short GIF** for the inline `![]()` thumbnail since GitHub won't autoplay MP4 via markdown.

**Records the real running app** — anything Chromium renders appears verbatim, so coverage is bounded by the app, not the LLM. AutoDemo (have-different) is bounded by reproduction fidelity. *Idea (optional hybrid):* when a preview URL exists, screenshot the real changed route and drop PNGs into a Remotion `<Img>` sequence under the existing Camera/Spotlight/Caption layer — raises fidelity on complex UIs while keeping the branded look.

**Multi-step user flows** (navigate/click/type/hover/scroll). AutoDemo animates only a single hero element. *Idea:* extend the DemoPlan/scene schema to carry an ordered step list (each = hero state + caption + camera focus) and have `ReleaseDemo` sequence them, approximating a flow without a browser.

**Runtime data via `setup` + `app.hint`** (seeded/authenticated state injected into prompts). AutoDemo reads only static source + Tailwind tokens. *Idea:* add an optional `sampleData`/`context` field to `meta.json` that the agent must use to populate realistic names/counts/avatars — cheap addition to the existing fixture contract.

**CI test pipeline + release automation** — `ci.yml` (unit + integration jobs) gates every PR; `release.yml` publishes versioned releases. AutoDemo has neither. *Idea:* add a `ci.yml` with a fast `check` job (typecheck + `validate-selftest.mts` + lint) and a `render-smoke` job running `pnpm render --offline --feature dark-mode-toggle` (no API key needed). Add a tag-triggered `release.yml` that attaches a sample MP4.

### Medium relevance

- **Trigger modes + magnitude gating** (auto/on-demand/smart, threshold, include/exclude globs). AutoDemo has only a hard-coded `*.tsx under apps/web/components` scope filter (partial). *Idea:* add `shouldRun` using diff stats already computed in `analyze.ts`; expose `--min-changes`.
- **Distributed CLI via `npx` + `init` scaffolding.** AutoDemo packages are private/unpublished (have a `bin` but not runnable externally). *Idea:* add `autodemo init` to scaffold config/fixtures; note AutoDemo is repo-coupled (reads `apps/web` tokens), so full portability needs a config-path indirection.
- **Schema-validated config file** (`git-glimpse.config.ts`, Zod). AutoDemo uses env vars + hard-coded constants (`SCENE_FRAMES`, `1920x1080`) — partial. *Idea:* introduce `autodemo.config.ts` (Zod already a dep) consolidating brand/tokens-path/globPrefix/timing/model.
- **GIF default output** — GIF is *why* inline embedding works. AutoDemo emits MP4 only (have-different). *Idea:* add a GIF target (Remotion `codec:'gif'` or two-pass FFmpeg palette).
- **Idempotent single PR comment** (hidden marker + find-and-update). AutoDemo's `gh pr comment` creates a new comment every run. *Idea:* embed an HTML-comment marker, list comments, PATCH the existing one.
- **Machine-readable Action outputs** (`recording-url`, `comment-url`, `success`). *Idea:* have `publish()` emit `out/publish.json` / `$GITHUB_OUTPUT` (`demo-path`, `plan-json`, `success`).
- **Always-visual comment via screenshot fallback.** AutoDemo guarantees a non-empty *video* (MissingScene) but the comment embeds no image (have-different). *Idea:* reuse `stills.ts` to embed one poster frame in the comment.
- **Animated cursor + click-ripple overlay** (`showMouseClicks`). AutoDemo has no cursor (only Spotlight/zoom). *Idea:* add a Remotion `<Cursor>` driven by `{x,y,action,frame}` waypoints in the scene contract.
- **Diff-aware fallback** — git-glimpse's fallback still shows the *real* change (screenshots); AutoDemo falls back to two unrelated canned scenes (have-different). *Idea:* on agent failure, render a before/after source/diff card for the actual changed component.
- **Real test suite** (~21 tests, tiered Vitest configs) vs AutoDemo's single self-test (partial). *Idea:* adopt Vitest, convert `validate-selftest.mts` to specs for the riskiest pure-logic surface (`validate.ts`), add a root `test` script.
- **Contributor docs + runnable examples** (`CONTRIBUTING.md`, `CLAUDE.md`, `examples/`). AutoDemo has only README. *Idea:* add `CLAUDE.md` capturing the agent prompt contract + `validate.ts` invariants.
- **Lint step**, **explicit LICENSE** (AGPL-3.0), and **cost/spend docs** — all absent or partial in AutoDemo. *Idea:* add ESLint/Biome + `lint` script; add a LICENSE matching intended distribution; add a "Cost & tokens" README section (AutoDemo's single-shot call with `AUTODEMO_MAX_TOKENS=16000` default vs git-glimpse's 4096 script cap).

### Low relevance

- **Lightweight pre-check action** (`check-trigger` emits `should-run` to gate heavy FFmpeg/Playwright installs). Largely N/A to AutoDemo (no Playwright/FFmpeg), though a fast `autodemo check` subcommand could gate the ~90MB Chrome download.

## 4. What AutoDemo does that git-glimpse doesn't

- **No app/runtime required** — reproduces UI from source, so it works without booting the app, a preview URL, FFmpeg, or Playwright. Avoids git-glimpse's documented 2–4 min CI install overhead and the fragility of starting/auth'ing a live app.
- **Cinematic, branded output** — `<Camera>` zoom, `<Spotlight>` scrim, `<Caption>` accent pill, and a branded Intro→scene(s)→Outro structure. git-glimpse produces a plain screen recording with only a cursor overlay.
- **Deterministic, hole-free timeline** — strict agent-output validation (requires `export default` + schema, forbids audio/network/remote imports, `.default()` on every field; fail-fast on truncated output), plus a `MissingScene` placeholder so a scene is never empty.
- **Serializable DemoPlan** (Zod-validated JSON) cleanly separated from non-serializable components, passable as Remotion `inputProps`.
- **Higher token budget for richer single-shot generation** (16000 vs git-glimpse's 4096 script cap).
- **Auto-regenerated scene registry** with collision-safe index-prefixed imports.

(Note: git-glimpse leads on most *distribution/maturity* axes; AutoDemo's advantages are concentrated in *architecture and output polish*.)

## 5. Honest take

**When git-glimpse fits better:** you want a turnkey, drop-in PR tool *today* (one-line `uses:`), you need true-to-life fidelity (real data, third-party widgets, complex/ureproducible UIs), or you want to demo multi-step user flows. It's also the more mature codebase (tests, CI, license, docs, published Action).

**When AutoDemo fits better:** you want a polished, on-brand marketing/release-style clip rather than a raw screen capture, you can't or don't want to boot the app in CI (no preview infra, auth headaches, flaky E2E), or you value deterministic, controllable output. Today it's a manual hackathon MVP, so it suits experimentation over production adoption.

**Three highest-leverage ideas to borrow (on the Remotion + Claude stack):**
1. **Wire the GitHub Action + event trigger** — the single biggest gap. AutoDemo's `--git <range>` code path already exists; only the trigger binding and a thin `action.yml` are missing. This converts it from a manual demo into a real PR tool.
2. **Host the media + embed it inline (with a GIF thumbnail)** — without this, the posted comment shows nothing viewable. Upload `out/demo.mp4` (artifact or draft-release), emit a short GIF for `![]()`, link the MP4, and make the comment idempotent via a marker.
3. **Add a smoke-test CI + Vitest specs for `validate.ts`** — using the offline known-good scenes, an API-key-free `render --offline` smoke job plus unit tests on the invariant parser gate regressions cheaply and credibly, closing the largest maturity gap.