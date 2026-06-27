// Applies ONLY to the `remotion` CLI (studio / `remotion render`).
// Programmatic rendering in @autodemo/cli passes `webpackOverride` to bundle()
// directly (see packages/cli/src/render.ts) — keep the two in sync.
import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

Config.setVideoImageFormat("jpeg");
Config.overrideWebpackConfig(enableTailwind);
