import { execFileSync } from "node:child_process";
import path from "node:path";
import type { FeatureRecSource } from "@autodemo/cli/feature-rec";

export type DiffContext = {
  range: string;
  files: string[];
  patch: string;
  frontendSources: FeatureRecSource[];
};

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function readAt(repoRoot: string, ref: string, file: string): string {
  try {
    return git(repoRoot, ["show", `${ref}:${file}`]);
  } catch {
    return "";
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}

function isFrontendCandidate(file: string): boolean {
  const ext = path.extname(file);
  if (file.includes(".test.") || file.includes(".spec.") || file.includes(".stories.")) return false;
  if (ext === ".tsx" || ext === ".jsx") return true;
  if (ext === ".css" || ext === ".scss") return true;
  if (![".ts", ".js"].includes(ext)) return false;
  return /(^|\/)(app|pages|components|ui|src\/components|src\/app|src\/pages)\//.test(file);
}

function isReproducibleSource(file: string): boolean {
  return [".tsx", ".jsx"].includes(path.extname(file));
}

export function collectDiffContext(input: {
  repoRoot: string;
  baseSha: string;
  headSha: string;
  prTitle: string;
  prNumber: number;
}): DiffContext {
  const range = `${input.baseSha}...${input.headSha}`;
  const files = git(input.repoRoot, ["diff", "--name-only", range])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const patch = git(input.repoRoot, ["diff", "--find-renames", "--unified=80", range]).slice(0, 80_000);

  const frontendSources = files
    .filter(isFrontendCandidate)
    .filter(isReproducibleSource)
    .slice(0, 3)
    .map((file) => ({
      id: slugify(path.basename(file, path.extname(file)) || file),
      file,
      before: readAt(input.repoRoot, input.baseSha, file),
      after: readAt(input.repoRoot, input.headSha, file),
      prTitle: input.prTitle,
      prNumber: input.prNumber,
      caption: `Validate ${path.basename(file)}`,
    }))
    .filter((source) => source.after.trim().length > 0);

  return { range, files, patch, frontendSources };
}

export function heuristicFrontendVisible(files: string[], patch: string): {
  frontendVisible: boolean;
  confidence: number;
  reason: string;
  userImpact: string;
  files: string[];
} {
  const frontendFiles = files.filter(isFrontendCandidate);
  if (frontendFiles.length === 0) {
    return {
      frontendVisible: false,
      confidence: 0.75,
      reason: "No changed files look like frontend/UI sources.",
      userImpact: "",
      files: [],
    };
  }
  return {
    frontendVisible: true,
    confidence: 0.65,
    reason: "Changed files include frontend/UI candidates. ANTHROPIC_API_KEY was not set, so Feature-Rec used the conservative heuristic.",
    userImpact: patch.includes("className") ? "Visual styling or component markup may have changed." : "",
    files: frontendFiles,
  };
}
