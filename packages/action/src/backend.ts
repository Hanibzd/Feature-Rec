import fs from "node:fs";
import type { ClassifierResult, RunStartRequest } from "@feature-rec/core";
import { RunStartResponseSchema } from "@feature-rec/core";

// The backend already settled this failure itself (cycle failed, check run
// written with an actionable message): there is nothing left to report, so
// the runner must NOT call failCycle and overwrite that message.
export class SettledBackendError extends Error {}

async function throwBackendError(context: string, response: Response): Promise<never> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { settled?: boolean; message?: string; error?: string };
    if (parsed.settled === true) {
      throw new SettledBackendError(parsed.message ?? parsed.error ?? text);
    }
  } catch (err) {
    if (err instanceof SettledBackendError) throw err;
    // Non-JSON body: fall through to the generic error.
  }
  throw new Error(`${context} failed: ${response.status} ${text}`);
}

function runnerToken(): string {
  const token = process.env.FEATURE_REC_RUNNER_TOKEN;
  if (!token) throw new Error("FEATURE_REC_RUNNER_TOKEN is required to call the Feature-Rec backend.");
  return token;
}

function headers(): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${runnerToken()}`,
  };
}

async function postJson<T>(apiUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwBackendError(`Feature-Rec backend ${path}`, response);
  }
  return (await response.json()) as T;
}

export async function startCycle(apiUrl: string, input: RunStartRequest) {
  return RunStartResponseSchema.parse(await postJson(apiUrl, "/api/runs/start", input));
}

export async function acceptCycle(
  apiUrl: string,
  cycleId: string,
  classifier: ClassifierResult,
  attemptId: string,
): Promise<void> {
  await postJson(apiUrl, `/api/runs/${cycleId}/accepted`, { ...classifier, attemptId });
}

export async function failCycle(
  apiUrl: string,
  cycleId: string,
  message: string,
  attemptId: string,
): Promise<void> {
  await postJson(apiUrl, `/api/runs/${cycleId}/failed`, { message, attemptId });
}

export async function uploadVideo(
  apiUrl: string,
  cycleId: string,
  file: string,
  attemptId: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    Authorization: `Bearer ${runnerToken()}`,
    // Octet-stream body carries no JSON, so the attempt token rides on a header.
    "x-feature-rec-attempt": attemptId,
  };
  const response = await fetch(`${apiUrl}/api/runs/${cycleId}/video`, {
    method: "POST",
    headers,
    body: new Blob([new Uint8Array(fs.readFileSync(file))]),
  });
  if (!response.ok) {
    await throwBackendError("Feature-Rec backend video upload", response);
  }
}
