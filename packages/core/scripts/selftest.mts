import assert from "node:assert/strict";
import {
  buildCycleKey,
  isAllowedPullRequestEvent,
  parseFeatureRecConfig,
  renderTemplate,
} from "../src/index";

const config = parseFeatureRecConfig(`
version: 1
github:
  checkName: Feature-Rec
  acceptComment: "@{pr_author} validation passed; you can merge."
  rejectComment: "@claude make the following changes:\\n\\n{review_comment}"
slack:
  channel: "C0123"
  mention: "<!subteam^S123|@reviewers>"
  approverUsergroups: ["S123"]
`);

assert.equal(config.github.checkName, "Feature-Rec");
assert.equal(config.slack.approverUsergroups[0], "S123");
assert.equal(
  renderTemplate(config.github.acceptComment, { pr_author: "romain" }),
  "@romain validation passed; you can merge.",
);
assert.equal(
  buildCycleKey({
    owner: "o",
    repo: "r",
    prNumber: 7,
    headSha: "abc1234",
    configHash: "cfg",
  }),
  "o/r#7:abc1234:cfg",
);
assert.equal(
  isAllowedPullRequestEvent({
    action: "opened",
    pull_request: { state: "open", draft: false },
  }),
  true,
);
assert.equal(
  isAllowedPullRequestEvent({
    action: "reopened",
    pull_request: { state: "open", draft: false },
  }),
  false,
);
assert.equal(
  isAllowedPullRequestEvent({
    action: "synchronize",
    pull_request: { state: "open", draft: true },
  }),
  false,
);

console.log("core selftest passed");
