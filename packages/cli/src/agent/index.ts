import { API_KEY_VARIABLES, createLlmClient, resolveLlmConfig } from "@feature-rec/llm";
import type { Feature, ProjectTokens } from "../analyze";
import { log } from "../log";
import { writeSceneFile } from "../scenes";
import { callLlm } from "./llm";
import { hasOfflineScene } from "./offline";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { extractCodeBlock, validateScene } from "./validate";

export type ReplicationSource = "llm" | "offline";

export type ReplicationResult = {
  id: string;
  source: ReplicationSource;
  wrote: boolean;
};

/**
 * Turn one detected UI change into a Remotion scene file.
 * Order of preference: LLM agent (if a key is configured) -> known-good fallback.
 */
export async function replicate(
  feature: Feature,
  tokens: ProjectTokens,
  opts: { offline?: boolean } = {},
): Promise<ReplicationResult> {
  // Offline mode never resolves the config, so it cannot fail on LLM settings.
  const config = opts.offline ? null : resolveLlmConfig(process.env);

  if (config) {
    try {
      log.info(`Calling the replication agent for "${feature.id}"…`);
      const raw = await callLlm(createLlmClient(config), config, {
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(feature, tokens),
      });
      const code = validateScene(extractCodeBlock(raw));
      writeSceneFile(feature.id, code);
      log.ok(`Agent reproduced "${feature.id}" → scenes/generated/${feature.id}.tsx`);
      return { id: feature.id, source: "llm", wrote: true };
    } catch (err) {
      log.warn(`Agent failed for "${feature.id}": ${(err as Error).message}`);
      if (hasOfflineScene(feature.id)) {
        log.warn(`Using the known-good scene for "${feature.id}" instead.`);
        return { id: feature.id, source: "offline", wrote: false };
      }
      // Rethrow the original error (truncation hint, provider failure or
      // validation) so the check run shows the actual cause.
      throw err;
    }
  }

  if (hasOfflineScene(feature.id)) {
    if (opts.offline) log.info(`Offline mode — using known-good scene for "${feature.id}".`);
    else log.info(`No LLM API key — using known-good scene for "${feature.id}".`);
    return { id: feature.id, source: "offline", wrote: false };
  }

  throw new Error(
    `Cannot replicate "${feature.id}": no LLM API key set and no known-good scene available. ` +
      `Set ${API_KEY_VARIABLES} to let the agent generate it.`,
  );
}
