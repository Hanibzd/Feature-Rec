import fs from "node:fs";
import path from "node:path";
import type { Feature, ProjectTokens } from "./analyze";
import { replicate } from "./agent";
import { buildPlan, writePlan } from "./compose";
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

function readFirstExisting(repoRoot: string, candidates: string[]): string {
  for (const candidate of candidates) {
    const file = path.join(repoRoot, candidate);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  return "";
}

export function readTargetProjectTokens(repoRoot: string): ProjectTokens {
  return {
    tailwindConfig: readFirstExisting(repoRoot, [
      "tailwind.config.ts",
      "tailwind.config.js",
      "apps/web/tailwind.config.ts",
      "apps/web/tailwind.config.js",
    ]),
    globalsCss: readFirstExisting(repoRoot, [
      "app/globals.css",
      "src/app/globals.css",
      "apps/web/app/globals.css",
      "styles/globals.css",
      "src/styles/globals.css",
    ]),
  };
}

export async function renderFeatureRecVideo(input: {
  repoRoot: string;
  sources: FeatureRecSource[];
  offline?: boolean;
}): Promise<string> {
  if (input.sources.length === 0) {
    throw new Error("Cannot render Feature-Rec video: no reproducible frontend source was found.");
  }

  const tokens = readTargetProjectTokens(input.repoRoot);
  const features: Feature[] = input.sources.map((source) => ({
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
  }));

  const ok: Feature[] = [];
  for (const feature of features) {
    await replicate(feature, tokens, { offline: input.offline });
    ok.push(feature);
  }

  regenerateRegistry();
  writePlan(buildPlan(ok));
  return renderDemo();
}
