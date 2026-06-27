import fs from "node:fs";
import type { ClassifierResult, FeatureRecConfig, RunStartRequest } from "@feature-rec/core";
import { RunStartResponseSchema } from "@feature-rec/core";

function headers(): HeadersInit {
  const token = process.env.FEATURE_REC_RUNNER_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function postJson<T>(apiUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Feature-Rec backend ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function startCycle(
  apiUrl: string,
  input: Omit<RunStartRequest, "config"> & { config: FeatureRecConfig },
) {
  return RunStartResponseSchema.parse(await postJson(apiUrl, "/api/runs/start", input));
}

export async function acceptCycle(
  apiUrl: string,
  cycleId: string,
  classifier: ClassifierResult,
): Promise<void> {
  await postJson(apiUrl, `/api/runs/${cycleId}/accepted`, classifier);
}

export async function failCycle(apiUrl: string, cycleId: string, message: string): Promise<void> {
  await postJson(apiUrl, `/api/runs/${cycleId}/failed`, { message });
}

export async function uploadVideo(apiUrl: string, cycleId: string, file: string): Promise<void> {
  const token = process.env.FEATURE_REC_RUNNER_TOKEN;
  const response = await fetch(`${apiUrl}/api/runs/${cycleId}/video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: new Blob([new Uint8Array(fs.readFileSync(file))]),
  });
  if (!response.ok) {
    throw new Error(`Feature-Rec backend video upload failed: ${response.status} ${await response.text()}`);
  }
}
