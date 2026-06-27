import assert from "node:assert/strict";
import { collectDiffContext, heuristicFrontendVisible } from "../src/diff";

assert.equal(
  heuristicFrontendVisible(["README.md", ".github/workflows/ci.yml"], "").frontendVisible,
  false,
);
assert.equal(
  heuristicFrontendVisible(["apps/web/components/Button.tsx"], "+ className").frontendVisible,
  true,
);
assert.equal(typeof collectDiffContext, "function");

console.log("action selftest passed");
