import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { ClassifierResultSchema, type ClassifierResult } from "@feature-rec/core";
import { z } from "zod";
import { heuristicFrontendVisible } from "./diff";

export type Classification = ClassifierResult & {
  // Set when Claude could not answer (invalid key, exhausted credit, spend
  // limit, outage) and the filename heuristic decided instead. Rendering needs
  // the same key, so the caller must not start a render while this is set.
  providerError?: string;
};

export function extractClassifierJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("Classifier returned no JSON object.");
  return JSON.parse(stripped.slice(start, end + 1));
}

function heuristicClassification(input: { files: string[]; patch: string }, cause: string): ClassifierResult {
  const heuristic = heuristicFrontendVisible(input.files, input.patch);
  return ClassifierResultSchema.parse({ ...heuristic, reason: `${heuristic.reason} ${cause}` });
}

// The Anthropic error body nests its text under error.message.
const ProviderErrorBodySchema = z.object({ error: z.object({ message: z.string() }) });

// Prefer the provider's own error text over the SDK message, which otherwise
// dumps the whole JSON body. Neither carries the key or headers. Outage pages
// can be long, so cap the detail.
function describeProviderError(err: APIError): string {
  const body = ProviderErrorBodySchema.safeParse(err.error);
  const detail = (body.success ? body.data.error.message : err.message).replace(/\s+/g, " ").trim().slice(0, 300);
  const status = err.status ? ` ${err.status}` : "";
  const type = err.type ? ` (${err.type})` : "";
  return `Anthropic API error${status}${type}: ${detail}`;
}

export async function classifyFrontendVisible(input: {
  files: string[];
  patch: string;
  prTitle: string;
}): Promise<Classification> {
  if (!process.env.ANTHROPIC_API_KEY) {
    const heuristic = heuristicClassification(
      input,
      "ANTHROPIC_API_KEY was not set, so Feature-Rec used the filename heuristic.",
    );
    if (heuristic.frontendVisible && process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER !== "1") {
      throw new Error(
        "ANTHROPIC_API_KEY is required to classify frontend-visible changes. Set FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1 to use the filename heuristic instead.",
      );
    }
    return heuristic;
  }

  const client = new Anthropic();
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: process.env.FEATURE_REC_MODEL ?? process.env.AUTODEMO_MODEL ?? "claude-sonnet-4-6",
      max_tokens: 1200,
      system:
        "You classify pull request diffs for Feature-Rec. Return strict JSON only. No markdown.",
      messages: [
        {
          role: "user",
          content: `Decide whether this PR contains a frontend-visible change worth sending for Slack validation.

For this run, return false for backend-only, env-only, docs-only, tests-only, dependency-only, lockfile-only, or CI-only changes.
Return true for UI, UX, copy, layout, styling, route, visual state, or frontend user-flow changes.

Return exactly this JSON shape:
{
  "frontendVisible": boolean,
  "confidence": number,
  "reason": string,
  "userImpact": string,
  "files": string[]
}

PR title: ${input.prTitle}

Changed files:
${input.files.map((file) => `- ${file}`).join("\n")}

Diff:
\`\`\`diff
${input.patch}
\`\`\``,
        },
      ],
    });
  } catch (err) {
    // A broken key or a provider outage must not fail the required check on
    // every PR of the repository. The filename heuristic decides instead, and
    // the reason names the cause so the check summary shows it on each PR.
    if (!(err instanceof APIError)) throw err;
    const providerError = describeProviderError(err);
    return {
      ...heuristicClassification(
        input,
        `Claude could not classify this PR (${providerError}), so the filename heuristic decided. Check the workflow's ANTHROPIC_API_KEY and the Anthropic account.`,
      ),
      providerError,
    };
  }

  if (message.stop_reason === "max_tokens") {
    throw new Error("Classifier response was truncated.");
  }

  const raw = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return ClassifierResultSchema.parse(extractClassifierJson(raw));
}
