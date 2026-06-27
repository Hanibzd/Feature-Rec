#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import {
  type Feature,
  featureFromFixture,
  featuresFromGit,
  listFixtures,
  readProjectTokens,
} from "./analyze";
import { replicate } from "./agent";
import { buildPlan, writePlan } from "./compose";
import { log } from "./log";
import { publish } from "./publish";
import { renderDemo } from "./render";
import { regenerateRegistry } from "./scenes";

type GenerateOpts = { feature?: string; git?: string; offline?: boolean };

function resolveFeatures(opts: GenerateOpts): Feature[] {
  if (opts.git) return featuresFromGit(opts.git);
  if (opts.feature) return [featureFromFixture(opts.feature)];
  return listFixtures().map(featureFromFixture);
}

async function runGenerate(opts: GenerateOpts): Promise<void> {
  log.banner("Generate scenes from the diff");
  const tokens = readProjectTokens();

  const features = resolveFeatures(opts);
  if (features.length === 0) {
    log.error("No UI changes detected (no fixtures / no matching diff).");
    process.exitCode = 1;
    return;
  }
  log.step(`${features.length} feature(s): ${features.map((f) => f.id).join(", ")}`);

  const ok: Feature[] = [];
  for (const feature of features) {
    try {
      await replicate(feature, tokens, { offline: opts.offline });
      ok.push(feature);
    } catch (err) {
      log.error(`Skipping "${feature.id}": ${(err as Error).message}`);
    }
  }

  if (ok.length === 0) {
    log.error("No scenes could be produced.");
    process.exitCode = 1;
    return;
  }

  const ids = regenerateRegistry();
  log.ok(`Registry rebuilt: ${ids.join(", ")}`);

  const plan = buildPlan(ok);
  writePlan(plan);
  log.ok(`Plan written → out/plan.json (${plan.scenes.length} scene(s))`);
  log.done("Generation complete.");
}

const program = new Command();
program
  .name("autodemo")
  .description("Every release publishes its own video — reproduce the UI diff 1:1 in Remotion, animate the new element, render an MP4.");

program
  .command("generate")
  .description("Detect UI changes and reproduce them as animated Remotion scenes")
  .option("--feature <id>", "use a single fixture by id (e.g. dark-mode-toggle)")
  .option("--git <range>", "detect features from a git diff range (e.g. HEAD~1)")
  .option("--offline", "skip the API and use known-good scenes only", false)
  .action(runGenerate);

program
  .command("render")
  .description("Bundle + render the current plan to out/demo.mp4")
  .action(async () => {
    log.banner("Render");
    await renderDemo();
    log.done("Render complete.");
  });

program
  .command("publish")
  .description("Write changelog + PR comment (optionally post via gh)")
  .option("--post", "post the comment to the PR via the gh CLI", false)
  .action((opts: { post?: boolean }) => {
    log.banner("Publish");
    publish({ post: opts.post });
    log.done("Publish complete.");
  });

program
  .command("demo")
  .description("Full pipeline: generate → render → publish")
  .option("--feature <id>", "use a single fixture by id")
  .option("--git <range>", "detect features from a git diff range")
  .option("--offline", "skip the API and use known-good scenes only", false)
  .action(async (opts: GenerateOpts) => {
    await runGenerate(opts);
    if (process.exitCode === 1) return;
    log.banner("Render");
    await renderDemo();
    log.banner("Publish");
    publish({ post: false });
    log.done("AutoDemo finished — see out/demo.mp4");
  });

// Drop standalone "--" tokens: `pnpm run demo -- --feature x` forwards the
// separator, which would otherwise make commander treat --feature as a positional.
const argv = process.argv.filter((a) => a !== "--");

program.parseAsync(argv).catch((err) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
