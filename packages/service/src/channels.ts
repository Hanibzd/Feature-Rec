import {
  SLACK_MULTIPLE_CHANNELS_MESSAGE,
  SLACK_NO_CHANNEL_MESSAGE,
  slackSelectedChannelUnavailableMessage,
} from "@feature-rec/core";
import type { SlackClient } from "./slack";
import type { CycleStore } from "./storage";

export class ChannelResolutionError extends Error {}

// Resolved at post time from the explicit workspace route and a transient live
// membership poll. Slack membership snapshots are never persisted.
export async function resolveChannel(
  store: CycleStore,
  slack: SlackClient,
): Promise<{ teamId: string; channelId: string }> {
  const { teamId } = await slack.botIdentity();
  const [route, channelIds] = await Promise.all([
    store.getTeamChannelRoute(teamId),
    slack.listBotChannels(),
  ]);

  if (route) {
    if (!channelIds.includes(route.selectedChannelId)) {
      throw new ChannelResolutionError(
        slackSelectedChannelUnavailableMessage(route.selectedChannelId),
      );
    }
    return { teamId, channelId: route.selectedChannelId };
  }

  if (channelIds.length === 0) throw new ChannelResolutionError(SLACK_NO_CHANNEL_MESSAGE);
  if (channelIds.length > 1) {
    throw new ChannelResolutionError(SLACK_MULTIPLE_CHANNELS_MESSAGE);
  }

  const channelId = channelIds[0];
  const initialized = await store.initializeTeamChannelRoute({ teamId, channelId });
  if (initialized.initializedRoute) return { teamId, channelId };

  // A join event or command won the initialization race. Honor that route,
  // provided it is still represented by this command's live snapshot.
  const current = await store.getTeamChannelRoute(teamId);
  if (current && channelIds.includes(current.selectedChannelId)) {
    return { teamId, channelId: current.selectedChannelId };
  }
  throw new ChannelResolutionError(
    current
      ? slackSelectedChannelUnavailableMessage(current.selectedChannelId)
      : SLACK_NO_CHANNEL_MESSAGE,
  );
}
