import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP_GLOBALS, APP_TAILWIND, FIXTURES_DIR, REPO_ROOT } from "./paths";

/** One detected UI change to turn into a scene. */
export type Feature = {
  id: string;
  file: string;
  prTitle: string;
  prNumber: number;
  releaseTag: string;
  productName: string;
  description: string;
  caption: string;
  before: string;
  after: string;
};

/** Project design tokens injected into the replication agent. */
export type ProjectTokens = {
  tailwindConfig: string;
  globalsCss: string;
};

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function readProjectTokens(): ProjectTokens {
  return {
    tailwindConfig: readIfExists(APP_TAILWIND),
    globalsCss: readIfExists(APP_GLOBALS),
  };
}

/* ---------------------------------- fixtures --------------------------------- */

export function listFixtures(): string[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => fs.existsSync(path.join(FIXTURES_DIR, d.name, "after.tsx")))
    .map((d) => d.name)
    .sort();
}

export function featureFromFixture(id: string): Feature {
  const dir = path.join(FIXTURES_DIR, id);
  if (!fs.existsSync(dir)) {
    throw new Error(`Fixture not found: ${id} (looked in ${dir})`);
  }
  const before = readIfExists(path.join(dir, "before.tsx"));
  const after = readIfExists(path.join(dir, "after.tsx"));
  if (!after) throw new Error(`Fixture ${id} has no after.tsx`);

  let meta: Record<string, unknown> = {};
  const metaPath = path.join(dir, "meta.json");
  if (fs.existsSync(metaPath)) {
    meta = JSON.parse(readIfExists(metaPath));
  }

  return {
    id,
    file: String(meta.file ?? `${id}.tsx`),
    prTitle: String(meta.prTitle ?? `Add ${id}`),
    prNumber: Number(meta.prNumber ?? 0),
    releaseTag: String(meta.releaseTag ?? "v0.1.0"),
    productName: String(meta.productName ?? "Acme"),
    description: String(meta.description ?? ""),
    caption: String(meta.caption ?? `New — ${id}`),
    before,
    after,
  };
}

/* ------------------------------------ git ----------------------------------- */

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}

/**
 * Resolve a diff range into the refs that `git diff <range>` actually compares:
 * - "A...B"  → before = merge-base(A,B), after = B           (committed)
 * - "A..B"   → before = A,               after = B           (committed)
 * - "REF"    → before = REF,             after = working tree
 * `tip` is the ref whose commit message describes the change.
 */
function resolveRange(range: string): {
  beforeRef: string;
  afterRef: string | null;
  tip: string;
} {
  if (range.includes("...")) {
    const [a, b] = range.split("...");
    const left = a || "HEAD";
    const right = b || "HEAD";
    let beforeRef = left;
    try {
      beforeRef = git(["merge-base", left, right]);
    } catch {
      beforeRef = left;
    }
    return { beforeRef, afterRef: right, tip: right };
  }
  if (range.includes("..")) {
    const [a, b] = range.split("..");
    const right = b || "HEAD";
    return { beforeRef: a || "HEAD", afterRef: right, tip: right };
  }
  // Single ref: `git diff REF` compares REF against the working tree.
  return { beforeRef: range, afterRef: null, tip: "HEAD" };
}

/**
 * Build features from a git diff range (e.g. "HEAD~1" or "main...HEAD").
 * Finds changed *.tsx component files, reads before/after via `git show` at the
 * exact refs the range compares (working tree for a single ref).
 */
export function featuresFromGit(range: string, globPrefix = "apps/web/components"): Feature[] {
  const { beforeRef, afterRef, tip } = resolveRange(range);

  const changed = git(["diff", "--name-only", range])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => f.endsWith(".tsx") && f.startsWith(globPrefix));

  if (changed.length === 0) return [];

  let subject = "UI update";
  try {
    subject = git(["log", "-1", "--pretty=%s", tip]);
  } catch {
    /* ignore */
  }

  return changed.map((file) => {
    let before = "";
    try {
      before = git(["show", `${beforeRef}:${file}`]);
    } catch {
      before = "";
    }
    let after = "";
    if (afterRef) {
      try {
        after = git(["show", `${afterRef}:${file}`]);
      } catch {
        after = "";
      }
    } else {
      after = readIfExists(path.join(REPO_ROOT, file));
    }

    const id = slugify(path.basename(file, ".tsx") || subject);
    return {
      id,
      file,
      prTitle: subject,
      prNumber: 0,
      releaseTag: "v0.1.0",
      productName: "Acme",
      description: subject,
      caption: `New — ${subject}`,
      before,
      after,
    };
  });
}
