import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCycleKey, parseFeatureRecConfig } from "@feature-rec/core";
import { SqliteCycleStore } from "../src/storage/sqlite";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-rec-"));
const store = new SqliteCycleStore(path.join(dir, "test.sqlite"));
const config = parseFeatureRecConfig(`
version: 1
github:
  checkName: Feature-Rec
  acceptComment: "@{pr_author} validation passed; you can merge."
  rejectComment: "@claude make the following changes:\\n\\n{review_comment}"
slack:
  channel: "C0123"
  mention: ""
  approverUsergroups: []
`);

const start = {
  owner: "MathFreedom",
  repo: "Agora",
  prNumber: 1,
  prTitle: "Add button",
  prAuthor: "romain",
  headSha: "abc1234567",
  baseSha: "def1234567",
  configHash: "0123456789abcdef",
  checkName: "Feature-Rec",
  config,
};
const cycleKey = buildCycleKey(start);
const one = store.upsertCycle({ ...start, cycleKey });
const two = store.upsertCycle({ ...start, cycleKey });

assert.equal(one.id, two.id);
assert.equal(one.config.slack.channel, "C0123");
assert.equal(store.recordProcessedInteraction("i1", one.id), true);
assert.equal(store.recordProcessedInteraction("i1", one.id), false);
store.updateStatus(one.id, "pending_validation");
assert.equal(store.getCycle(one.id)?.status, "pending_validation");
store.close();

console.log("service selftest passed");
