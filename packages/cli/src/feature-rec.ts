import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Feature, ProjectTokens } from "./analyze";
import { repairScenes, replicate } from "./agent";
import type { RevisionReader } from "./agent/real";
import { resetTargetTheme, writeTargetTheme } from "./agent/theme";
import { buildPlan, writePlan } from "./compose";
import { log } from "./log";
import { renderDemo } from "./render";
import { regenerateRegistry } from "./scenes";

export type FeatureRecSource = {
  id: string;
  file: string;
  before: string;
  after: string;
  prTitle: string;
  prNumber: number;
  caption: string;
};

const TAILWIND_CONFIGS = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];
const GLOBAL_CSS = [
  "app/globals.css",
  "src/app/globals.css",
  "styles/globals.css",
  "src/styles/globals.css",
  "src/index.css",
  "src/globals.css",
];

function firstExisting(repoRoot: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    for (const prefix of ["", "apps/web/"]) {
      const file = path.join(repoRoot, prefix + candidate);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

export function readTargetProjectTokens(repoRoot: string): ProjectTokens {
  const configPath = firstExisting(repoRoot, TAILWIND_CONFIGS);
  const cssPath = firstExisting(repoRoot, GLOBAL_CSS);
  return {
    tailwindConfig: configPath ? fs.readFileSync(configPath, "utf8") : "",
    globalsCss: cssPath ? fs.readFileSync(cssPath, "utf8") : "",
    tailwindConfigPath: configPath ?? undefined,
  };
}

/** Repository files at the PR's base (BEFORE) and head (AFTER) commits, through git. */
function gitReader(repoRoot: string, revisions: { base: string; head: string }): RevisionReader {
  return (revision, repoPath) => {
    try {
      return execFileSync("git", ["show", `${revision === "before" ? revisions.base : revisions.head}:${repoPath}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

/** Does `source` (the file at `importer`) import `target`? Relative paths and "@/"/"~/" aliases. */
function importsFile(importer: string, source: string, target: string): boolean {
  const stem = (file: string) => file.replace(/\.(tsx|jsx|ts|js)$/, "").replace(/\/index$/, "");
  const goal = stem(target);
  return [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].some(([, spec]) => {
    if (spec.startsWith(".")) return stem(path.posix.join(path.posix.dirname(importer), spec)) === goal;
    const tail = stem(spec).replace(/^[@~]\//, "");
    return goal === tail || goal.endsWith(`/${tail}`);
  });
}

/**
 * Where the changed component is used: files at the PR head that import it (pages, parents).
 * Their markup is the component's real surroundings (a form's page title, a card's list), so
 * the scene can frame it the way users meet it without inventing anything.
 */
function findUsages(repoRoot: string, head: string, file: string): Array<{ path: string; content: string }> {
  const name = path.posix.basename(file).replace(/\.(tsx|jsx)$/, "");
  if (!name || name === "index") return [];
  let listed = "";
  try {
    listed = execFileSync("git", ["grep", "-l", "-F", "-e", name, head, "--", "*.tsx", "*.jsx"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return []; // no match (git grep exits 1)
  }
  const usages: Array<{ path: string; content: string }> = [];
  for (const line of listed.split("\n")) {
    const candidate = line.slice(line.indexOf(":") + 1).trim();
    if (!candidate || candidate === file || usages.length >= 2) continue;
    let content = "";
    try {
      content = execFileSync("git", ["show", `${head}:${candidate}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    if (content.length < 12_000 && importsFile(candidate, content, file)) usages.push({ path: candidate, content });
  }
  return usages;
}

/**
 * Changed files that another changed file imports are shown in context by that file's scene
 * (a new <BillingToggle> inside the pricing card it was added to), so they get no scene of
 * their own. Matching is by import path; aliases are matched on the path's tail.
 */
export function withoutComponentsShownInContext<T extends { file: string; after: string }>(sources: T[]): T[] {
  const stem = (file: string) => file.replace(/\.(tsx|jsx|ts|js)$/, "").replace(/\/index$/, "");
  return sources.filter((candidate) => {
    const target = stem(candidate.file);
    return !sources.some((other) => {
      if (other === candidate) return false;
      return [...other.after.matchAll(/\bfrom\s*["']([^"']+)["']/g)].some(([, spec]) => {
        const resolved = spec.startsWith(".") ? stem(path.posix.join(path.posix.dirname(other.file), spec)) : stem(spec);
        if (spec.startsWith(".")) return resolved === target;
        // alias ("@/components/x", "~/ui/x"): compare the aliased path with the file's path tail
        const tail = resolved.replace(/^[@~]\//, "");
        return target === tail || target.endsWith(`/${tail}`);
      });
    });
  });
}

const isNoOpClick = (err: Error) => /changed nothing in the real component/.test(err.message);

export async function renderFeatureRecVideo(input: {
  repoRoot: string;
  sources: FeatureRecSource[];
  offline?: boolean;
  /** PR commits; enables real components with local imports (read through git). */
  revisions?: { base: string; head: string };
}): Promise<string> {
  if (input.sources.length === 0) {
    throw new Error("Cannot render Feature-Rec video: no reproducible frontend source was found.");
  }

  const tokens = readTargetProjectTokens(input.repoRoot);
  let themeDeclarations = 0;
  if (input.offline) resetTargetTheme();
  else {
    themeDeclarations = await writeTargetTheme({ configPath: tokens.tailwindConfigPath ?? null, globalsCss: tokens.globalsCss });
    if (themeDeclarations > 0) log.ok(`Target Tailwind theme loaded (${themeDeclarations} declarations).`);
  }
  const read = input.revisions ? gitReader(input.repoRoot, input.revisions) : undefined;

  const sources = withoutComponentsShownInContext(input.sources);
  if (sources.length < input.sources.length) {
    const kept = new Set(sources);
    log.info(`Shown in context, no own scene: ${input.sources.filter((s) => !kept.has(s)).map((s) => s.file).join(", ")}`);
  }
  const features: Feature[] = sources.map((source) => ({
    id: source.id,
    file: source.file,
    prTitle: source.prTitle,
    prNumber: source.prNumber,
    releaseTag: `PR #${source.prNumber}`,
    productName: "Feature-Rec",
    description: source.prTitle,
    caption: source.caption,
    before: source.before,
    after: source.after,
    usages: input.revisions ? findUsages(input.repoRoot, input.revisions.head, source.file) : undefined,
  }));

  const ok: Feature[] = [];
  for (const feature of features) {
    await replicate(feature, tokens, { offline: input.offline, read, themeLoaded: themeDeclarations > 0 });
    ok.push(feature);
  }

  regenerateRegistry();
  writePlan(buildPlan(ok));
  try {
    return await renderDemo({ strictClicks: true });
  } catch (firstError) {
    let error = firstError as Error;
    // A theme the renderer cannot compile must never cost the video: retry without it.
    if (themeDeclarations > 0 && !isNoOpClick(error)) {
      log.warn(`Render failed with the target theme (${error.message.split("\n")[0]}); retrying without it.`);
      resetTargetTheme();
      try {
        return await renderDemo({ strictClicks: true });
      } catch (err) {
        error = err as Error;
      }
    }
    const repaired = await repairScenes(error.stack ?? error.message);
    if (repaired.length > 0) {
      log.warn(`Render failed; repaired ${repaired.join(", ")} and rendering again.`);
      regenerateRegistry();
      try {
        return await renderDemo({ strictClicks: true });
      } catch (err) {
        error = err as Error;
      }
    }
    // A click that still does nothing is a weak demo, not a reason to send no video.
    if (isNoOpClick(error)) {
      log.warn("A pointer click still changes nothing after the repair; rendering the video anyway.");
      return renderDemo({ strictClicks: false });
    }
    throw error;
  }
}
