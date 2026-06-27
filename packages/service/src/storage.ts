import type { ReviewCycle, ReviewCycleStatus, RunStartRequest } from "@feature-rec/core";
import type { FeatureRecConfig } from "@feature-rec/core";

export type CycleRecord = ReviewCycle & {
  prAuthor: string;
  prTitle: string;
  config: FeatureRecConfig;
};

export type CycleStore = {
  upsertCycle(input: RunStartRequest & { cycleKey: string }): CycleRecord;
  getCycle(id: string): CycleRecord | null;
  getCycleByKey(cycleKey: string): CycleRecord | null;
  markSupersededForPr(input: {
    owner: string;
    repo: string;
    prNumber: number;
    exceptHeadSha: string;
  }): CycleRecord[];
  updateCheckRun(id: string, checkRunId: number): void;
  updateStatus(id: string, status: ReviewCycleStatus): void;
  updateSlackMessage(id: string, channelId: string, messageTs: string): void;
  hasProcessedInteraction(id: string): boolean;
  recordProcessedInteraction(id: string, cycleId: string): boolean;
  close(): void;
};
