import assert from "node:assert/strict";
import {
  buildCycleKey,
  GITHUB_ACCEPT_COMMENT,
  GITHUB_REJECT_COMMENT,
  isAllowedPullRequestEvent,
  renderTemplate,
  SLACK_GREETING_ACTIVE,
  SLACK_MULTIPLE_CHANNELS_MESSAGE,
  SLACK_NO_CHANNEL_MESSAGE,
  slackSelectedChannelUnavailableMessage,
} from "../src/index";

assert.equal(
  renderTemplate(GITHUB_ACCEPT_COMMENT, { pr_author: "romain" }),
  "@romain validation passed, you can merge.",
);
assert.equal(
  renderTemplate(GITHUB_REJECT_COMMENT, {
    pr_author: "romain",
    review_comment: "make it feel premium",
  }),
  "@romain make the following changes:\n\nmake it feel premium",
);
assert.equal(
  buildCycleKey({
    owner: "o",
    repo: "r",
    prNumber: 7,
    headSha: "abc1234",
  }),
  "o/r#7:abc1234",
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

assert.equal(SLACK_GREETING_ACTIVE.includes("{"), false);
assert.ok(SLACK_GREETING_ACTIVE.includes("/feature-rec help"));
assert.equal(SLACK_NO_CHANNEL_MESSAGE.includes("{"), false);
assert.ok(SLACK_MULTIPLE_CHANNELS_MESSAGE.includes("/feature-rec channel"));
assert.equal(
  slackSelectedChannelUnavailableMessage("C0123"),
  "Feature-Rec is not currently in the selected review channel <#C0123>. Invite @Feature-Rec back or run `/feature-rec channel #another-channel` from any workspace conversation, then re-run.",
);

console.log("core selftest passed");
