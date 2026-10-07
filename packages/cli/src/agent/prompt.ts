import fs from "node:fs";
import path from "node:path";
import type { Feature, ProjectTokens } from "../analyze";
import { VIDEO_SRC } from "../paths";
import type { RealComponents } from "./real";

/**
 * Scene-generation prompt. The model writes the staging of one scene with the scene kit
 * (packages/video/src/kit); the UI comes from the PR's real files when possible ("real mode",
 * see real.ts), otherwise the model rebuilds it from the diff.
 *
 * The system prompt and the kit reference (`cached`) never change between requests, so they
 * are sent as cacheable blocks; everything specific to the pull request goes in `request`.
 */

const example = (file: string) =>
  fs.readFileSync(path.join(VIDEO_SRC, "kit/examples", file), "utf8").replaceAll('from "../index"', 'from "../../kit"');

export const SYSTEM_PROMPT = `You are Feature-Rec's demo-video engineer. For one pull request that changes UI, you write
ONE Remotion scene: a ~6 second clean screen recording that lets a product manager, watching on a
phone in Slack, understand WHAT changed and HOW the new thing works.

TASTE — clean, native, calm
- The video looks like a polished screen recording of the real product (think Linear / Vercel
  changelog clips). Only two things are on screen: the product UI and, if useful, the pointer.
- NEVER add: glows, rings or outlines that are not in the UI, dimming, spotlights, arrows, labels,
  captions, title cards, browser chrome, logos, placeholder/skeleton page content, confetti.
- The whole UI is visible first. The Stage handles framing and any zoom; you never scale,
  translate or zoom the UI yourself.
- Motion is sparse and purposeful: one change, shown once, clearly. No bouncing, no shaking.

SHOW HOW IT WORKS
- Start on the BEFORE state for ~1 second, so the viewer sees what was there.
- Then make the change happen the way a user would experience it:
  - new interactive element (button, link, toggle, menu): it appears (Reveal), then the pointer
    moves to it, hovers (render its real hover: classes), clicks, and the result is shown;
  - flow (dialog, form, validation): the pointer drives 1-3 steps, typing uses Typewriter;
  - passive content (panel, text, badge): it appears with Reveal; no pointer gymnastics;
  - restyle / copy change of an existing element: Swap the element in place.
- Reproduce interaction states only from the code: hover:, active:, disabled:, focus states,
  open/closed states. Never invent a result the code does not produce.

FIDELITY
- Reuse the component's markup, classNames and copy exactly. Data shown = data in the code.
- Custom Tailwind tokens of the target repo: see THEME in the request.
- Imported child components without source (Button, Card, Dialog, Input...): rebuild them plainly
  from their name, props and the tokens (shadcn/ui conventions if the path says so).
- Lay the UI out as it sits on its page, at a realistic size (viewport 1440px wide). Render ONLY
  the changed component (and the dialog/menu it opens). Its surround is the plain page
  background: no empty boxes, cards, hero sections, skeleton lines or sample page content.
- Exception, page chrome (header, nav bar, footer, sidebar): ONE <PageHint /> is REQUIRED where
  the page content sits (below a header, above a footer, beside a sidebar), OUTSIDE the
  data-focus="ui" element, so the viewer understands what the component is. Nothing else.
- Wide components (headers, nav bars, toolbars) read small at overview size: always add a
  focus moment on the changed part so the Stage can bring it to a readable size. With several
  changes in one component, focus each one in turn (~40 frames each).

SCREEN, NOT PAGE BOX
- The Stage background IS the page background: set it to the page color and never paint a
  page-sized background box (it shows as bands at the screen edges when the camera moves).
- Never use position: fixed or a full-page absolute overlay. Dialogs, drawers, sheets, command
  palettes and toasts go through <Modal> so their backdrop covers the whole screen.

HARD CONSTRAINTS
- Deterministic: no Date.now(), Math.random(), timers, network, remote assets. Inline SVG icons.
- Motion only from useCurrentFrame()/spring()/interpolate() and the kit. No CSS transitions,
  no transition-* or animate-* classes, no @keyframes.
- No audio.`;

const KIT_DOC = `SCENE KIT — import { Stage, Reveal, Swap, Typewriter, Modal, PageHint, Morph, useProgress } from "../../kit";
<Stage> is the root of every scene.
  children: JSX, or a function ({ frame, hovered, pressed }) => JSX
     hovered(id) / pressed(id): true while the pointer is over / clicking the element with
     data-focus={id}. Use them to switch to the element's real hover:/active: classes.
  focus?: { from: number; id?: string; text?: string; selector?: string }[]   moments that matter.
     The Stage decides whether to ease in slightly (only if the element is small) and keeps the
     UI on screen. Usually 0 or 1.
  pointer?: { path: { frame: number; to: Target }[]; clicks?: number[] }
     Target = a data-focus id (string), { text: "exact visible text" }, { selector: "css" }, or a
     screen point { x, y } in the 1920x1080 frame (for the resting position). The pointer lands on
     the target's center. Moves are eased; keep 20-30 frames per move.
     Add data-cursor="text" on a text field's data-focus element to show an I-beam over it.
  background: the page background implied by the UI.  fontFamily={fontFamily} unless told otherwise.
  viewportWidth?: layout width, default 1440.
Mark the outermost element of the reproduced UI with data-focus="ui" (the Stage frames it whole),
and give each element you point at or focus a short data-focus id.

<Reveal at={frame} duration?={18} axis?="y"|"x">  new element growing into the flow (siblings move
  naturally). axis="x" for inline elements (a badge next to a label, a button in a row).
<Swap at={frame} duration?={12} before={<.../>} after={<.../>} inline?={true}>  same element,
  before → after, cross-faded in one place (no layout jump, no duplicated text).
<Typewriter text="..." from={frame} cps?={14} focusAt?={frame} />  typed characters + caret.
<Modal open={progress} placement?="center"|"right"|"bottom-right" dim?={0.4}>  anything that covers
  the screen in the product: dialog (center), drawer/sheet (right), toast (bottom-right, no dim).
  Rendered in screen space: the backdrop covers the WHOLE frame and the content keeps the UI scale.
  Put only the panel inside (no backdrop, no fixed wrapper); data-focus targets inside work.
<PageHint tone?="light"|"dark" height?={520} maxWidth?={1152} />  one soft block standing for
  "the rest of the page", only next to page chrome (see FIDELITY).
<Morph at={frame} before={...} after={...} />  REAL COMPONENTS only (see the request): animates the
  real BEFORE into the real AFTER (new parts grow in, changed styles interpolate).
useProgress(at, duration?) → 0..1 smooth (no bounce) progress, for anything custom
  (dialog opacity/scale 0.98→1, a toggle knob sliding, a backdrop fading).

TIMELINE: exactly 175 frames at 30fps. ~0-30 BEFORE, ~30-120 the change and its use,
~120-175 calm hold on the AFTER state.

INTEGRATION
- File: packages/video/src/scenes/generated/<id>.tsx. Imports allowed: "../../kit", "../../font"
  (export fontFamily), "remotion", "zod", "react", and the real-component imports given in the request.
- MUST: \`export default function Scene(props: Partial<z.infer<typeof schema>>)\` and
  \`export const schema = z.object({...})\` where EVERY field has .default(...); start with
  \`const { ... } = schema.parse(props ?? {})\`. The root element returned is <Stage>.

REFERENCE SCENES — the quality bar. Same kit, different products. Match their restraint.

Example 1 (new control, then its use):
\`\`\`tsx
${example("CopyInviteLink.tsx")}
\`\`\`

Example 2 (flow with typing):
\`\`\`tsx
${example("RenameWorkspace.tsx")}
\`\`\``;

function realSection(real: RealComponents): string {
  return `REAL COMPONENTS — THIS OVERRIDES THE FIDELITY RULES ABOVE
The PR's actual files are copied next to your scene and render with their real classNames:
\`\`\`tsx
${real.importLines}
\`\`\`
- Render the UI ONLY through ${real.hasBefore ? "<Before /> and <After />" : "<After />"}. Never retype, restyle or
  re-implement their markup, never wrap them in extra cards, borders or shadows.
- Transition: ${
    real.hasBefore
      ? "<Morph at={frame} before={...} after={...} />. Default duration."
      : "a new file: show <After /> appearing with useProgress opacity."
  }
- Pass the props their signature requires, with realistic values taken from the code.
- Lay them out like their page does. Morph gives both versions the full width of its container:
  full-width components (header, section) go in a full-width wrapper; a fixed-width card centered
  by its page goes in a wrapper of the card's width, and each version is centered inside:
  before={<div className="flex justify-center"><Before /></div>}. Put data-focus="ui" on the
  wrapper around <Morph>, never inside the components.
- Stage: background="${real.pageBackground ?? "the page background implied by the UI"}"${
    real.appFont
      ? `, fontFamily={APP_FONT} with const APP_FONT = ${JSON.stringify(real.appFont)} (the app's own font; do not use the kit font)`
      : ""
  }.
- Targets inside them (pointer AND focus): { text: "exact visible text" } or { selector: "css" },
  e.g. focus={[{ from: 50, text: "Start free trial" }]}. NEVER add invisible anchor elements or
  guess coordinates: the Stage measures the real elements.
  Pointer clicks are REAL: at each click frame the Stage clicks the targeted element, so the
  component runs its own onClick/state and its own CSS transitions. To show how a new control
  works, move the pointer to it and click it (a toggle without text: { selector: "button[aria-pressed]" }
  or a similar attribute selector from the code). Never fake a state by redrawing the component.
  Hover-only styles cannot be shown. Do not click links that would navigate away.
  Passive content (text, panel, badge) needs no pointer.
- Page chrome still gets <PageHint /> (outside data-focus="ui").`;
}

export function buildPrompt(
  feature: Feature,
  tokens: ProjectTokens,
  opts: { real: RealComponents | null; themeLoaded: boolean; localImports?: Array<{ path: string; content: string }> },
): { system: string; cached: string; request: string } {
  const theme = opts.themeLoaded
    ? "THEME: the renderer includes the target repo's Tailwind theme and CSS variables, so its custom\nutilities (bg-brand-600, text-muted-foreground, rounded-card…) work as written."
    : "THEME: the renderer has stock Tailwind v4 only. Custom tokens from the target repo (bg-brand-600,\ntext-muted-foreground, hsl(var(--x))…) do not exist: resolve them from the config/CSS below into\narbitrary values (bg-[#4f46e5]) or inline styles.";
  const request = `NOW THE PULL REQUEST
- Title: ${feature.prTitle}
- Description: ${feature.description || "(none)"}
- Scene id: ${feature.id}
- Changed file: ${feature.file}

${theme}

Tailwind config of the target repo:
\`\`\`ts
${tokens.tailwindConfig || "(none)"}
\`\`\`

Global CSS of the target repo:
\`\`\`css
${tokens.globalsCss || "(none)"}
\`\`\`

BEFORE:
\`\`\`tsx
${feature.before || "(new file)"}
\`\`\`

AFTER:
\`\`\`tsx
${feature.after}
\`\`\`
${opts.real ? `\n${realSection(opts.real)}\n` : ""}${
    !opts.real && opts.localImports?.length
      ? `\nLOCAL IMPORTS of the changed file (AFTER), to rebuild the pieces the diff does not show (their markup,\nclassNames and styles, CSS modules included — translate module classes to equivalent inline styles):\n${opts.localImports
          .map((f) => `--- ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n")}\n`
      : ""
  }
Answer in two parts:
1. PLAN — at most 7 short bullets: what changed (every visible delta), how a user would use it,
   page chrome? (yes → PageHint + a focus moment per change), the beats with frame numbers.
2. CODE — one \`\`\`tsx block with the complete scene file. Nothing after it.`;
  return { system: SYSTEM_PROMPT, cached: KIT_DOC, request };
}
