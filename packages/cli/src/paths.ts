import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/cli/src
export const REPO_ROOT = path.resolve(here, "../../../"); // monorepo root

export const VIDEO_DIR = path.join(REPO_ROOT, "packages/video");
export const VIDEO_SRC = path.join(VIDEO_DIR, "src");
export const VIDEO_ENTRY = path.join(VIDEO_SRC, "index.ts");
export const SCENES_DIR = path.join(VIDEO_SRC, "scenes");
export const GENERATED_DIR = path.join(SCENES_DIR, "generated");
export const REGISTRY_FILE = path.join(SCENES_DIR, "index.ts");

export const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");
export const APP_DIR = path.join(REPO_ROOT, "apps/web");
export const APP_TAILWIND = path.join(APP_DIR, "tailwind.config.ts");
export const APP_GLOBALS = path.join(APP_DIR, "app/globals.css");

export const OUT_DIR = path.join(REPO_ROOT, "out");
export const PLAN_FILE = path.join(OUT_DIR, "plan.json");
export const OUT_MP4 = path.join(OUT_DIR, "demo.mp4");
export const BUNDLE_CACHE = path.join(OUT_DIR, ".bundle");
export const CHANGELOG_FILE = path.join(OUT_DIR, "CHANGELOG.md");
export const PR_COMMENT_FILE = path.join(OUT_DIR, "pr-comment.md");
