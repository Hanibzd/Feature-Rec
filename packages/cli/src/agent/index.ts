import type { Feature, ProjectTokens } from "../analyze";
import { log } from "../log";
import { writeSceneFile } from "../scenes";
import { callClaude, hasApiKey } from "./anthropic";
import { hasOfflineScene } from "./offline";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { extractCodeBlock, validateScene } from "./validate";

export type ReplicationSource = "anthropic" | "offline";

export type ReplicationResult = {
  id: string;
  source: ReplicationSource;
  wrote: boolean;
};

/**
 * Turn one detected UI change into a Remotion scene file.
 * Order of preference: Claude agent (if a key is present) -> known-good fallback.
 */
export async function replicate(
  feature: Feature,
  tokens: ProjectTokens,
  opts: { offline?: boolean } = {},
): Promise<ReplicationResult> {
  const useApi = !opts.offline && hasApiKey();

  if (useApi) {
    try {
      log.info(`Calling the replication agent for "${feature.id}"…`);
      const raw = await callClaude({
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(feature, tokens),
      });
      const code = validateScene(extractCodeBlock(raw));
      writeSceneFile(feature.id, code);
      log.ok(`Agent reproduced "${feature.id}" → scenes/generated/${feature.id}.tsx`);
      return { id: feature.id, source: "anthropic", wrote: true };
    } catch (err) {
      log.warn(`Agent failed for "${feature.id}": ${(err as Error).message}`);
      if (hasOfflineScene(feature.id)) {
        log.warn(`Using the known-good scene for "${feature.id}" instead.`);
        return { id: feature.id, source: "offline", wrote: false };
      }
      throw err;
    }
  }

  if (hasOfflineScene(feature.id)) {
    if (opts.offline) log.info(`Offline mode — using known-good scene for "${feature.id}".`);
    else log.info(`No ANTHROPIC_API_KEY — using known-good scene for "${feature.id}".`);
    return { id: feature.id, source: "offline", wrote: false };
  }

  throw new Error(
    `Cannot replicate "${feature.id}": no ANTHROPIC_API_KEY set and no known-good scene available. ` +
      `Export ANTHROPIC_API_KEY to let the agent generate it.`,
  );
}
