import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { Feature, ProjectTokens } from "../analyze";
import { log } from "../log";
import { VIDEO_DIR } from "../paths";
import { writeSceneFile } from "../scenes";
import { callClaude, hasApiKey, type Turn } from "./anthropic";
import { hasOfflineScene } from "./offline";
import { buildPrompt } from "./prompt";
import { addsClickHandler, assertNoRetyping, localImportSources, prepareRealComponents, type RealComponents, type RevisionReader } from "./real";
import { extractCodeBlock, validateScene } from "./validate";

export type ReplicationSource = "anthropic" | "offline";

export type ReplicationResult = {
  id: string;
  source: ReplicationSource;
  wrote: boolean;
  /** true when the scene renders the PR's real files (see real.ts) */
  real: boolean;
};

/**
 * Captions are forbidden (the UI and the pointer tell the story), but a model facing a change
 * that is hard to show tends to label it. Rejects visible text that names before/after states
 * or shows code, unless that text exists in the sources.
 */
export function assertNoCaptions(code: string, sources: string): void {
  const texts = [...code.matchAll(/>\s*([^<>{}]*?[A-Za-z][^<>{}]*?)\s*</g)].map((m) => m[1].trim()).filter(Boolean);
  const literals = [...code.matchAll(/["'`]([^"'`\n]{3,80})["'`]/g)].map((m) => m[1]);
  const caption = [...texts, ...literals].find(
    (t) => /\b(before|after)\b\s*[:—–-](\s|$)|className\s*=|^\s*(before|after)\s*$/i.test(t) && !sources.includes(t),
  );
  if (caption) {
    throw new Error(
      `The scene shows a caption or code ("${caption.slice(0, 60)}"). No labels, captions or code on screen: only the product UI and the pointer.`,
    );
  }
}

/**
 * The video has to show what the PR changes. Rejects a scene whose pointer and focus moments only
 * visit elements the diff leaves untouched: every text target is found, with the lines just
 * around it, unchanged in the BEFORE source. A target missing from BEFORE is new (or lives in
 * another file of the PR) and counts as the change. Ids and selectors cannot be judged: allowed.
 */
export function assertTargetsTheChange(code: string, before: string, after: string): void {
  const targets = [...new Set([...code.matchAll(/\btext:\s*(["'`])([^"'`\n]+)\1/g)].map((m) => m[2]))];
  if (targets.length === 0 || before.trim() === "") return;
  const norm = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean).join("\n");
  const beforeText = norm(before.split("\n"));
  const afterLines = after.split("\n");
  const unchanged = (text: string) => {
    if (!before.includes(text)) return false;
    const at = afterLines.flatMap((l, i) => (l.includes(text) ? [i] : []));
    return at.length > 0 && at.every((i) => beforeText.includes(norm(afterLines.slice(Math.max(0, i - 1), i + 2))));
  };
  if (targets.every(unchanged)) {
    throw new Error(
      `The pointer and focus only visit elements this PR does not change (${targets.map((t) => `"${t}"`).join(", ")}). ` +
        `Point at what the PR adds or changes (and click it if it is interactive), or use no pointer for a passive change.`,
    );
  }
}

/** A PR that adds a control is shown by clicking it, not just by making it appear. */
export function assertClicksNewControl(code: string, addsControl: boolean): void {
  if (addsControl && !/\bclicks\s*:\s*\[\s*\d/.test(code)) {
    throw new Error(
      "This PR adds a clickable control (a new onClick/onCheckedChange/… handler) but the scene never clicks. " +
        "Show how it works: move the pointer to the new control and click the element that changes the UI.",
    );
  }
}

/** Generation attempts per scene: the first answer plus one repair with the error fed back. */
const ATTEMPTS = 2;

/** Conversation per scene id, kept so a scene that breaks the final render can be repaired. */
type Session = {
  id: string;
  system: string;
  cached: string;
  turns: Turn[];
  real: RealComponents | null;
  before: string;
  after: string;
  /** the PR adds a clickable control the scene should click */
  addsControl: boolean;
  /** all source text the scene may legitimately display (before, after, local imports) */
  sources: string;
};
const sessions = new Map<string, Session>();

const tsc = createRequire(path.join(VIDEO_DIR, "package.json")).resolve("typescript/bin/tsc");

/**
 * Type errors of one generated scene. Bundling strips types, so these do not fail the render
 * by themselves, but they reliably flag the bugs that do (undefined names, wrong kit props).
 * Errors in the PR's copied files are not the scene's and are ignored.
 */
function typecheckScene(id: string): string[] {
  try {
    execFileSync(process.execPath, [tsc, "--noEmit", "-p", VIDEO_DIR], { encoding: "utf8", stdio: "pipe", timeout: 180_000 });
    return [];
  } catch (err) {
    const out = String((err as { stdout?: string }).stdout ?? "");
    return out.split("\n").filter((line) => line.includes(`scenes/generated/${id}.tsx(`)).slice(0, 12);
  }
}

/** Ask, check, and write the scene; each failure is fed back to the model once. */
async function generate(session: Session, attempts: number): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const raw = await callClaude({ system: session.system, cached: session.cached, turns: session.turns });
    session.turns.push({ role: "assistant", content: raw });
    let problem: string;
    try {
      const code = validateScene(extractCodeBlock(raw));
      if (session.real) assertNoRetyping(code, session.after);
      assertNoCaptions(code, session.sources);
      writeSceneFile(session.id, code);
      // Storytelling checks: worth a retry, but never worth losing the video over.
      try {
        assertTargetsTheChange(code, session.before, session.after);
        assertClicksNewControl(code, session.addsControl);
      } catch (err) {
        if (attempt < attempts) throw err;
        log.warn(`Scene "${session.id}": ${(err as Error).message.split(".")[0]}; keeping it.`);
      }
      const typeErrors = typecheckScene(session.id);
      if (typeErrors.length === 0) return;
      if (attempt === attempts) {
        log.warn(`Scene "${session.id}" still has type errors; rendering it anyway:\n${typeErrors.join("\n")}`);
        return;
      }
      problem = `The scene has TypeScript errors:\n${typeErrors.join("\n")}`;
    } catch (err) {
      if (attempt === attempts) throw err;
      problem = (err as Error).message;
    }
    log.warn(`Scene "${session.id}" needs a fix (${problem.split("\n")[0]}); asking the agent again.`);
    session.turns.push({ role: "user", content: `${problem}\nFix it and return the complete corrected file in one tsx block.` });
  }
}

/**
 * Turn one detected UI change into a Remotion scene file.
 * Order of preference: Claude agent (if a key is present) -> known-good fallback.
 * With repository access (`read`), the PR's real components are used when they can be rendered.
 */
export async function replicate(
  feature: Feature,
  tokens: ProjectTokens,
  opts: { offline?: boolean; read?: RevisionReader; themeLoaded?: boolean } = {},
): Promise<ReplicationResult> {
  const useApi = !opts.offline && hasApiKey();

  if (useApi) {
    const real = prepareRealComponents({
      id: feature.id,
      file: feature.file,
      before: feature.before,
      after: feature.after,
      globalsCss: tokens.globalsCss,
      read: opts.read,
      onSkip: (reason) => log.info(`Real components unavailable for "${feature.id}" (${reason}); rebuilding the UI from the diff.`),
    });
    if (real) log.ok(`Real components for "${feature.id}": ${real.copied} file(s) rendered untouched.`);
    const localImports = !real && opts.read ? localImportSources(feature.file, opts.read) : [];
    const prompt = buildPrompt(feature, tokens, { real, themeLoaded: Boolean(opts.themeLoaded), localImports });
    const session: Session = {
      id: feature.id,
      system: prompt.system,
      cached: prompt.cached,
      turns: [{ role: "user", content: prompt.request }],
      real,
      before: feature.before,
      after: feature.after,
      addsControl: real ? real.addsControl : addsClickHandler(feature.before, feature.after),
      sources: [
        feature.before,
        feature.after,
        ...localImports.map((f) => f.content),
        ...(feature.usages ?? []).map((u) => u.content),
        ...(real?.changedFiles ?? []).map((f) => f.content),
      ].join("\n"),
    };
    sessions.set(feature.id, session);
    try {
      log.info(`Calling the replication agent for "${feature.id}"…`);
      await generate(session, ATTEMPTS);
      log.ok(`Agent reproduced "${feature.id}" → scenes/generated/${feature.id}.tsx`);
      return { id: feature.id, source: "anthropic", wrote: true, real: Boolean(real) };
    } catch (err) {
      sessions.delete(feature.id);
      log.warn(`Agent failed for "${feature.id}": ${(err as Error).message}`);
      if (hasOfflineScene(feature.id)) {
        log.warn(`Using the known-good scene for "${feature.id}" instead.`);
        return { id: feature.id, source: "offline", wrote: false, real: false };
      }
      throw err;
    }
  }

  if (hasOfflineScene(feature.id)) {
    if (opts.offline) log.info(`Offline mode — using known-good scene for "${feature.id}".`);
    else log.info(`No ANTHROPIC_API_KEY — using known-good scene for "${feature.id}".`);
    return { id: feature.id, source: "offline", wrote: false, real: false };
  }

  throw new Error(
    `Cannot replicate "${feature.id}": no ANTHROPIC_API_KEY set and no known-good scene available. ` +
      `Export ANTHROPIC_API_KEY to let the agent generate it.`,
  );
}

/**
 * The final render failed: feed the error back to the scenes it names (all generated scenes
 * when it names none), with the same attempts as a first generation. Returns the ids rewritten.
 */
export async function repairScenes(renderError: string): Promise<string[]> {
  const named = [...sessions.values()].filter((s) => renderError.includes(s.id));
  const targets = named.length > 0 ? named : [...sessions.values()];
  const repaired: string[] = [];
  for (const session of targets) {
    session.turns.push({
      role: "user",
      content: `Rendering the video failed:\n${renderError.slice(0, 2000)}\nFix the scene and return the complete corrected file in one tsx block.`,
    });
    try {
      await generate(session, ATTEMPTS);
      repaired.push(session.id);
    } catch (err) {
      log.warn(`Repair failed for "${session.id}": ${(err as Error).message}`);
    }
  }
  return repaired;
}
