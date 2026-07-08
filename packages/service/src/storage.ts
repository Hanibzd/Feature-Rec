import type { ReviewCycle, ReviewCycleStatus, RunStartRequest } from "@feature-rec/core";
import type { FeatureRecConfig } from "@feature-rec/core";

export type CycleRecord = ReviewCycle & {
  prAuthor: string;
  prTitle: string;
  config: FeatureRecConfig;
};

export type CycleStore = {
  upsertCycle(input: RunStartRequest & { cycleKey: string }): Promise<CycleRecord>;
  getCycle(id: string): Promise<CycleRecord | null>;
  getCycleByKey(cycleKey: string): Promise<CycleRecord | null>;
  markSupersededForPr(input: {
    owner: string;
    repo: string;
    prNumber: number;
    exceptHeadSha: string;
  }): Promise<CycleRecord[]>;
  updateCheckRun(id: string, checkRunId: number): Promise<void>;
  updateStatus(id: string, status: ReviewCycleStatus): Promise<void>;
  updateSlackMessage(id: string, channelId: string, messageTs: string): Promise<void>;
  recordProcessedInteraction(id: string, cycleId: string): Promise<boolean>;
  close(): Promise<void>;
};
