import type { ChannelSettings } from "./storage";

function toSlackMentions(ids: string[]): string[] {
  return ids.map((id) => (id.startsWith("S") ? `<!subteam^${id}>` : `<@${id}>`));
}

/** Render stored approver/user IDs as Slack mrkdwn mentions, space-separated. */
export function renderApproverIds(ids: string[]): string {
  return toSlackMentions(ids).join(" ");
}

/** Natural-language join for status/confirmation copy. */
export function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Approver IDs rendered as a natural-language Slack mention list. */
export function formatApproverList(ids: string[]): string {
  return joinList(toSlackMentions(ids));
}

/**
 * Resolve the mention prefix that should precede a validation post.
 * null means post with no mention.
 */
export function effectiveMention(settings: ChannelSettings): string | null {
  switch (settings.mention.mode) {
    case "off":
      return null;
    case "custom":
      return settings.mention.audience;
    case "approvers":
      return settings.approvers?.length
        ? renderApproverIds(settings.approvers)
        : "<!channel>";
  }
}

function describeApproversLine(settings: ChannelSettings): string {
  if (settings.approvers?.length) {
    return `Approvers: ${formatApproverList(settings.approvers)}`;
  }
  return "Approvers: anyone in the channel";
}

function describeNotificationsLine(settings: ChannelSettings): string {
  switch (settings.mention.mode) {
    case "off":
      return "Notifications: off";
    case "custom":
      return `Notifications: custom — ${settings.mention.audience}`;
    case "approvers":
      return settings.approvers?.length
        ? `Notifications: following approvers — ${formatApproverList(settings.approvers)}`
        : "Notifications: following approvers — @channel";
  }
}

/** Shared approval + notification summary used by commands and confirmations. */
export function describeChannelSettings(settings: ChannelSettings): string {
  return `${describeApproversLine(settings)}\n${describeNotificationsLine(settings)}`;
}
