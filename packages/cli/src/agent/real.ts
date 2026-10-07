import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { GENERATED_DIR, VIDEO_DIR, VIDEO_SRC } from "../paths";

/**
 * "Real component" mode: the PR's actual BEFORE and AFTER files are copied next to the
 * generated scene and rendered untouched, so the UI is exact by construction. The model then
 * writes only the staging (framing, transition, pointer), never the UI markup.
 *
 * Local imports (relative paths and tsconfig aliases such as "@/components/...") are followed
 * and copied with the same directory layout, each revision read from its own commit. npm
 * imports are kept when the renderer can resolve them (React and the common UI libraries
 * installed in @autodemo/video); next/link and next/image get render stubs. Anything else
 * (CSS modules, providers' packages, assets) makes the change fall back to reconstruction.
 */

export type Revision = "before" | "after";
/** Reads a repository file at a revision; null when it does not exist there. */
export type RevisionReader = (revision: Revision, repoPath: string) => string | null;

export type RealComponents = {
  importLines: string;
  hasBefore: boolean;
  appFont: string | null;
  pageBackground: string | null;
  /** Repository files copied per revision (the changed file plus its local dependencies). */
  copied: number;
};

export class UnsupportedImportError extends Error {}

const MAX_FILES = 30;
const CODE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
const STUBS: Record<string, string> = {
  "next/link": path.join(VIDEO_SRC, "kit/stubs/next-link"),
  "next/image": path.join(VIDEO_SRC, "kit/stubs/next-image"),
  "next/navigation": path.join(VIDEO_SRC, "kit/stubs/next-navigation"),
  "next/router": path.join(VIDEO_SRC, "kit/stubs/next-router"),
};
const videoRequire = createRequire(path.join(VIDEO_DIR, "package.json"));

/** Static import/export-from specifiers, with the exact quoted text to rewrite. */
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*)(["'])([^"'\n]+)\2/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(|\brequire\s*\(/;

/** Type-only imports/exports are erased at compile time: they never need resolving. */
const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["'];?|^\s*import\s*\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\}\s*from\s*["'][^"']+["'];?/gm;
const withoutTypeOnlyImports = (source: string) => source.replace(TYPE_ONLY_RE, "");

function specifiers(source: string): string[] {
  return [...withoutTypeOnlyImports(source).matchAll(SPECIFIER_RE)].map((m) => m[3]);
}

function rewriteSpecifiers(source: string, map: Map<string, string>): string {
  return source.replace(SPECIFIER_RE, (whole, kw: string, quote: string, spec: string) =>
    map.has(spec) ? `${kw}${quote}${map.get(spec)}${quote}` : whole,
  );
}

const relativeImport = (fromFile: string, toFile: string): string => {
  const rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
};

type AliasRule = { prefix: string; targets: string[] };

/** tsconfig/jsconfig "paths" (comments and trailing commas tolerated), else the usual "@/" guesses. */
function aliasRules(read: (p: string) => string | null): AliasRule[] {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const raw = read(name);
    if (!raw) continue;
    try {
      const json = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const base = json.compilerOptions?.baseUrl ?? ".";
      const rules = Object.entries(json.compilerOptions?.paths ?? {})
        .filter(([key]) => key.endsWith("/*"))
        .map(([key, targets]) => ({
          prefix: key.slice(0, -1),
          targets: targets.filter((t) => t.endsWith("/*")).map((t) => path.posix.normalize(path.posix.join(base, t.slice(0, -1)))),
        }));
      if (rules.length > 0) return rules;
    } catch {
      // unreadable tsconfig: fall through to the conventional aliases
    }
  }
  return [
    { prefix: "@/", targets: ["src/", ""] },
    { prefix: "~/", targets: ["src/", ""] },
  ];
}

function onlyReactImports(source: string): boolean {
  return specifiers(source).every((s) => s === "react" || s.startsWith("react/"));
}

/** `import X from` for a default export, `import { Name as X } from` for a named one. */
function importLine(source: string, alias: string, from: string): string | null {
  if (/export\s+default\s+(async\s+)?(function|const|class)\b/.test(source) || /export\s+default\s+[A-Z]\w*\s*;?\s*$/m.test(source))
    return `import ${alias} from "${from}";`;
  const named = /export\s+(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/.exec(source);
  return named ? `import { ${named[1]} as ${alias} } from "${from}";` : null;
}

function cssValue(css: string, selector: string, prop: string): string | null {
  const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1];
  const value = block && new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`).exec(block)?.[1];
  return value ? value.trim() : null;
}

/**
 * Copy one revision of the changed file and its local import graph into `outDir`, keeping
 * repository-relative paths so relative imports keep working. Throws UnsupportedImportError.
 */
function copyRevision(entry: string, revision: Revision, read: RevisionReader, outDir: string): number {
  const readRev = (p: string) => read(revision, p);
  const aliases = aliasRules((p) => read("after", p));
  const resolveLocal = (base: string): string | null => {
    const ext = path.posix.extname(base);
    if (ext && !CODE_EXTENSIONS.includes(ext)) return null; // assets, CSS, JSON…
    const candidates = ext ? [base] : [...CODE_EXTENSIONS.map((e) => base + e), ...CODE_EXTENSIONS.map((e) => `${base}/index${e}`)];
    return candidates.find((c) => readRev(c) !== null) ?? null;
  };

  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > MAX_FILES) throw new UnsupportedImportError(`more than ${MAX_FILES} local files imported`);
    const source = readRev(file);
    if (source === null) throw new UnsupportedImportError(`${file} is missing at ${revision}`);
    if (DYNAMIC_IMPORT_RE.test(source)) throw new UnsupportedImportError(`${file} uses dynamic import/require`);

    const target = path.join(outDir, file);
    const rewrites = new Map<string, string>();
    for (const spec of specifiers(source)) {
      if (spec === "react" || spec.startsWith("react/") || spec === "react-dom" || spec.startsWith("react-dom/")) continue;
      if (STUBS[spec]) {
        rewrites.set(spec, relativeImport(target, STUBS[spec]));
        continue;
      }
      let local: string | null = null;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        local = resolveLocal(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
        if (!local) throw new UnsupportedImportError(`${spec} (from ${file}) is not a code file`);
      } else {
        const rule = aliases.find((r) => spec.startsWith(r.prefix));
        if (rule) {
          for (const t of rule.targets) {
            local = resolveLocal(path.posix.normalize(t + spec.slice(rule.prefix.length)));
            if (local) break;
          }
          if (!local) throw new UnsupportedImportError(`${spec} (from ${file}) could not be resolved`);
          rewrites.set(spec, relativeImport(target, path.join(outDir, local.replace(/\.(tsx|ts|jsx|js)$/, ""))));
        } else {
          try {
            videoRequire.resolve(spec);
          } catch {
            throw new UnsupportedImportError(`package "${spec}" (from ${file}) is not available to the renderer`);
          }
          continue;
        }
      }
      if (local) queue.push(local);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Type-only imports are dropped from the copy: the bundler must not try to resolve them.
    fs.writeFileSync(target, rewriteSpecifiers(withoutTypeOnlyImports(source), rewrites));
  }
  return seen.size;
}

/**
 * Prepare real mode for one changed file, or return null (with the reason logged by the
 * caller) when it cannot be rendered untouched. `read` gives access to other repository files;
 * without it only files that import nothing but React qualify.
 */
export function prepareRealComponents(input: {
  id: string;
  file: string;
  before: string;
  after: string;
  globalsCss: string;
  read?: RevisionReader;
  onSkip?: (reason: string) => void;
}): RealComponents | null {
  const { id, file, before, after, globalsCss } = input;
  if (!after) return null;
  const read: RevisionReader =
    input.read ??
    ((revision, p) => {
      if (p === file) return revision === "before" ? before || null : after;
      return null;
    });
  if (!input.read && (!onlyReactImports(after) || (before && !onlyReactImports(before)))) {
    input.onSkip?.("imports other modules and no repository access was given");
    return null;
  }

  const dir = path.join(GENERATED_DIR, id);
  fs.rmSync(dir, { recursive: true, force: true });
  const entryNoExt = file.replace(/\.(tsx|jsx|ts|js)$/, "");
  const lines: string[] = [];
  let copied = 0;
  try {
    if (before) {
      const line = importLine(before, "Before", `./${id}/before/${entryNoExt}`);
      if (!line) throw new UnsupportedImportError("the BEFORE file has no exported component");
      copied = copyRevision(file, "before", read, path.join(dir, "before"));
      lines.push(line);
    }
    const line = importLine(after, "After", `./${id}/after/${entryNoExt}`);
    if (!line) throw new UnsupportedImportError("the AFTER file has no exported component");
    copied = Math.max(copied, copyRevision(file, "after", read, path.join(dir, "after")));
    lines.push(line);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err instanceof UnsupportedImportError) {
      input.onSkip?.(err.message);
      return null;
    }
    throw err;
  }

  return {
    importLines: lines.join("\n"),
    hasBefore: Boolean(before),
    appFont: cssValue(globalsCss, "body", "font-family"),
    pageBackground: cssValue(globalsCss, "body", "background(?:-color)?") ?? (globalsCss ? "#FFFFFF" : null),
    copied,
  };
}

/**
 * Real mode guard: the scene must render the real files, not a retyped copy of them.
 * Rejects scenes that contain several className strings taken verbatim from the AFTER source.
 */
export function assertNoRetyping(code: string, after: string): void {
  const classes = new Set([...after.matchAll(/className="([^"]{16,})"/g)].map((m) => m[1]));
  const copied = [...classes].filter((c) => code.includes(c));
  if (copied.length >= 3) {
    throw new Error(
      `Scene retypes the real component's markup (${copied.length} classNames copied from the AFTER file, e.g. "${copied[0]}"). ` +
        "Render <Before /> / <After /> untouched. To show an interaction, click the real element with the pointer (clicks are real).",
    );
  }
}

/**
 * Reconstruction context: the AFTER source of the changed file's local imports (components,
 * utilities and stylesheets, CSS modules included), so a rebuilt UI matches pieces the diff does
 * not show. Best effort: unresolvable imports are skipped; bounded in files and size.
 */
export function localImportSources(
  file: string,
  read: RevisionReader,
  limits = { files: 6, chars: 20_000, depth: 2 },
): Array<{ path: string; content: string }> {
  const aliases = aliasRules((p) => read("after", p));
  const resolve = (base: string): string | null => {
    const ext = path.posix.extname(base);
    const candidates = ext ? [base] : [...CODE_EXTENSIONS.map((e) => base + e), ...CODE_EXTENSIONS.map((e) => `${base}/index${e}`)];
    return candidates.find((c) => read("after", c) !== null) ?? null;
  };
  const out: Array<{ path: string; content: string }> = [];
  const seen = new Set([file]);
  let chars = 0;
  let frontier = [file];
  for (let depth = 0; depth < limits.depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const spec of specifiers(read("after", current) ?? "")) {
        let local: string | null = null;
        if (spec.startsWith("./") || spec.startsWith("../")) local = resolve(path.posix.normalize(path.posix.join(path.posix.dirname(current), spec)));
        else {
          const rule = aliases.find((r) => spec.startsWith(r.prefix));
          for (const t of rule?.targets ?? []) {
            local = resolve(path.posix.normalize(t + spec.slice(rule!.prefix.length)));
            if (local) break;
          }
        }
        if (!local || seen.has(local)) continue;
        seen.add(local);
        const content = read("after", local);
        if (content === null || out.length >= limits.files || chars + content.length > limits.chars) continue;
        out.push({ path: local, content });
        chars += content.length;
        if (CODE_EXTENSIONS.includes(path.posix.extname(local))) next.push(local);
      }
    }
    frontier = next;
  }
  return out;
}
