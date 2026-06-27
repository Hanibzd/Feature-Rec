import Anthropic from "@anthropic-ai/sdk";
import { ClassifierResultSchema, type ClassifierResult } from "@feature-rec/core";
import { heuristicFrontendVisible } from "./diff";

export function extractClassifierJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("Classifier returned no JSON object.");
  return JSON.parse(stripped.slice(start, end + 1));
}

export async function classifyFrontendVisible(input: {
  files: string[];
  patch: string;
  prTitle: string;
}): Promise<ClassifierResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    const heuristic = ClassifierResultSchema.parse(heuristicFrontendVisible(input.files, input.patch));
    if (heuristic.frontendVisible && process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER !== "1") {
      throw new Error(
        "ANTHROPIC_API_KEY is required to classify frontend-visible changes. Set FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1 to use the conservative heuristic fallback.",
      );
    }
    return heuristic;
  }

  const client = new Anthropic();
  const message = await client.messages.create({
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

  if (message.stop_reason === "max_tokens") {
    throw new Error("Classifier response was truncated.");
  }

  const raw = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return ClassifierResultSchema.parse(extractClassifierJson(raw));
}
