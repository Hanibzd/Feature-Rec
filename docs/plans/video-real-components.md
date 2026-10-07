# Demo videos: scene kit and real components

Status: implemented on `feat/video-real-components`. Behavior is described in
[How Feature-Rec works](../product.md#demo-videos); this note keeps the design decisions and the
evidence behind them.

## Why

The previous agent retyped each changed component and animated it freehand. On a five-case
evaluation (two fixtures, the real test-repo pricing card, a shadcn dialog with imports, a header
with two changes; 15 to 25 generations per prompt, `claude-sonnet-4-6`):

- the UI filled a small part of the 1920x1080 frame and was unreadable on a phone (0/20 judged
  readable), and nothing showed what had changed;
- retyped markup drifted from the code (font, element order, page background);
- 7/20 scenes had TypeScript errors and 5/10 used CSS transitions, which Remotion does not render
  frame-accurately.

## Design

- **Scene kit** (`packages/video/src/kit`): `Stage` (frames the whole component at its final size,
  light zoom only for small elements, macOS pointer, hover/press state), `Reveal`, `Swap`,
  `Typewriter`, `Modal` (screen-space backdrop), `PageHint` (context block for page chrome),
  `Morph`. The model never computes pixel coordinates: it marks elements and states *when* things
  happen. Two hand-written reference scenes (`kit/examples`) set the quality bar in the prompt.
- **Real components** (`packages/cli/src/agent/real.ts`): when the changed file's import graph is
  local or uses libraries the renderer ships, the base/head files are copied next to the scene and
  rendered untouched. `Morph` diffs the two DOMs and animates new elements growing in and changed
  styles interpolating. Pointer clicks are replayed as real DOM clicks; children are remounted per
  click count so frames do not depend on render order.
- **Determinism**: real CSS transitions are frozen inside the Stage and replayed from the
  components' declared durations and curves (`kit/transitions.ts`); measurements ignore the camera
  transform. Verified bit-exact: 875/875 frames identical between a 1-tab and an 8-tab render.
- **Sandbox** (`kit/sandbox.ts`): no network from scene or PR code during the render.
- **Target theme** (`packages/cli/src/agent/theme.ts`): the repository's Tailwind config and
  global CSS variables become v4 `@theme`/`:root` declarations; plugins are not executed.
- **Guards** (`packages/cli/src/agent/index.ts`): scene validation, a retyping check in real
  mode, a TypeScript check of the scene, and one repair turn per failure (also after a failed
  render). System prompt and kit reference are prompt-cache breakpoints.

## Results on the same evaluation

| | Previous prompt | Scene kit + real components |
|---|---|---|
| Rendered on the first try | 20/20 | 24/25 (25/25 after the repair turn) |
| TypeScript errors | 7/20 | 2/25 |
| Output tokens / generation time | ~3,500 / ~46 s | ~1,100 / ~19 s |
| Input tokens | ~2,700 | ~6,600 (mostly cacheable) |

Cost per scene at `claude-sonnet-4-6` list prices: ~6.1¢ before, ~3.7¢ after, ~2.2¢ with a warm
prompt cache.

## Field tests

- **Test repository** (feature-rec/feature-rec-test-repo #4–#6, action pinned to this branch, real
  backend and Slack): a new local component with custom theme colors and a real click (real
  components, 2 files), the confidence panel (real, 1 file) and a CSS-module import (reconstruction
  with the module's styles from the local-import context). The first runs exposed two bugs fixed
  here: copied components hidden from Tailwind by `.gitignore`, and rebuilds missing the source of
  in-context components.
- **Open-source repository** (shadcn-ui/taxonomy, replayed locally): a copy change in the sign-in
  form and an avatar fallback change. Both fell back to reconstruction (Radix UI, next-auth,
  react-hook-form are not shipped by the renderer). The copy change came out right; the avatar
  scene invented a dashboard header around the avatar. These runs led to type-only import
  elision, Next routing stubs, the alias fix for in-context files and the caption guard.

- **Held-out check** (commits never used while tuning: taxonomy pricing page and sign-in toast,
  precedent nav bar and home card; test-repo PRs replayed locally, the billing toggle three
  times). Review of these videos led to general fixes rather than per-case ones: the component's
  importers at the PR head are given as context (WHERE IT IS USED) instead of inventing
  surroundings; the camera never crops the component (wide chrome framed edge to edge, clicks and
  focus lean in at most to 90% of the frame); `PageHint` renders inside flex layouts; cross-fades
  are staggered so two texts never overlap; the default text color follows the page background;
  a scene whose pointer and focus only visit elements the diff leaves untouched is sent back to
  the model (`assertTargetsTheChange`).

## Open issues

- shadcn codebases mostly fall back to reconstruction because their primitives import Radix UI.
  Shipping the non-portal Radix primitives (slot, avatar, label, separator, switch, checkbox, tabs,
  …) would cover many of them; portal-based ones (dialog, popover, dropdown, tooltip, select)
  also need their portals routed into the Stage overlay.
- Reconstruction of very small components without importers in the repository (no WHERE IT IS
  USED context) shows them alone; their page context is not recovered.

- Real mode cannot show `hover:` styles or replay typing into real inputs (clicks only).
- Components that need providers (router, data fetching, i18n) or packages the renderer does not
  ship fall back to reconstruction.
- If a PR removes elements, `Morph` falls back to a short cross-fade.
- Scene length is fixed at 175 frames (5.8 s), short for three-step flows.
