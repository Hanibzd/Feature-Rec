import type { Feature, ProjectTokens } from "../analyze";

export const SYSTEM_PROMPT = `You are the AutoDemo UI Replication Agent.
You convert a UI code change into an animated Remotion scene that REPRODUCES the
changed interface 1:1 and animates the NEW/CHANGED element. Reproduce — do not redesign.

Hard rules (never violate):
- Reproduce, don't invent. Reuse the source component's EXACT Tailwind classNames
  (or inline the extracted hex/px styles if it doesn't use Tailwind). Colors and
  typography come from the code, never made up.
- NO audio. Never emit <Audio>, useAudioData, or any sound.
- NO network. No fetch/XMLHttpRequest/import of remote assets. Inline SVGs only.
- Frames are SCENE-RELATIVE (the scene is wrapped in a Series.Sequence).
- Output format is strict (see OUTPUT). Return ONLY the 5 sections.`;

/**
 * Integration contract — what the generated file may rely on so it drops into
 * packages/video/src/scenes/generated/<id>.tsx and renders inside ReleaseDemo.
 */
const INTEGRATION_CONTRACT = `INTEGRATION CONTRACT (the file is saved to packages/video/src/scenes/generated/<id>.tsx)
- Composition is 1920x1080 @ 30fps. Your scene is a full-frame <AbsoluteFill>.
- It MUST: export default the component, and export a named \`schema\` (a zod object).
  Every schema field MUST have a .default() so partial props still render.
- The component signature is \`export default function Scene(props: Partial<z.infer<typeof schema>>)\`;
  start with \`const { ... } = schema.parse(props ?? {})\`.
- You MAY import these stable helpers (use them — don't re-implement):
    import { Camera, Spotlight, Caption } from "../../components";
    import { COLORS, RADIAL_BG, SPRING_SMOOTH, SPRING_POP } from "../../tokens";
    import { fontFamily } from "../../font";
  plus anything from "remotion" and "zod".
- Set \`style={{ background: RADIAL_BG, fontFamily }}\` on the root AbsoluteFill so the
  reproduced UI inherits the Inter font and sits on the dark stage.
- <Camera scale originX originY opacity> scales the stage toward a focus point given in
  COMPOSITION px. You place the hero, so you KNOW its center — set focus.x/focus.y to it.
- <Spotlight x y radius opacity> is a screen-space scrim with a radial hole over the hero.
- <Caption text x y startFrame accent> is a screen-space pill labelling the change.
- The hero (the added/changed element) is the ONLY thing animated. Surrounding UI is
  static context, reproduced faithfully.`;

const CHOREOGRAPHY = `ANIMATION (scene-relative frames, target 150-180 total)
  [0-14]   stage + context UI fade/scale in (interpolate + Easing.out(cubic), clamp).
  [14-30]  hero reveal: spring SPRING_SMOOTH (toggle slides on / button pops / row expands).
  [40-..]  CAMERA ZOOM onto the hero via <Camera> using SPRING_SMOOTH toward focus.x/y;
           hold, then ease back near the end. Drive <Spotlight> opacity/radius by the same
           zoom progress (0..1).
  [~54]    <Caption> pops in (SPRING_POP) near the hero.`;

export function buildUserPrompt(feature: Feature, tokens: ProjectTokens): string {
  return `INPUT
- PR title: ${feature.prTitle}
- Feature description: ${feature.description || "(none)"}
- Scene id (filename): ${feature.id}
- Source file: ${feature.file}

Design tokens (reuse verbatim) — tailwind.config.ts:
\`\`\`ts
${tokens.tailwindConfig || "(none)"}
\`\`\`

Design tokens — globals.css:
\`\`\`css
${tokens.globalsCss || "(none)"}
\`\`\`

Changed component, BEFORE:
\`\`\`tsx
${feature.before || "(new file)"}
\`\`\`

Changed component, AFTER:
\`\`\`tsx
${feature.after}
\`\`\`

${INTEGRATION_CONTRACT}

${CHOREOGRAPHY}

Produce the following 5 sections. Sections 1-4 are concise bullets. Section 5 is the code.

1. VISUAL SPECS — extracted FROM THE CODE (never invented): exact colors (hex/rgb), typography
   (family/weight/size resolved from Tailwind), layout structure, and the position of the changed
   element within it. Inline any SVG/icons present in the diff.
2. VIDEO CONFIGURATION — 1920x1080 @ 30fps; duration in frames for THIS scene (150-180); the
   reproduced UI centered on the dark stage (it is live components, not a screenshot).
3. DATA & PROPS (zod) — the schema with .default() on every field: brandPrimary, any text/number
   that could vary, and focus { x, y, scale }.
4. ANIMATION LOGIC — diff BEFORE vs AFTER to find the HERO; give exact frame ranges and which
   spring/interpolate drives each part.
5. OUTPUT — ONE self-contained Remotion React functional component, reproducing the changed
   component's markup 1:1 with its exact classNames, following the INTEGRATION CONTRACT above.

Return ONLY sections 1-4 as short bullets, then section 5 as a single \`\`\`tsx code block.`;
}
