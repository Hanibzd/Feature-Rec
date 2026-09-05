import crypto from "node:crypto";
import type { RunStartRequest } from "@feature-rec/core";
import {
  GITHUB_ACCEPT_COMMENT,
  GITHUB_CHECK_NAME,
  GITHUB_REJECT_COMMENT,
  renderTemplate,
} from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import { withRetry } from "./retry";
import type { CycleRecord } from "./storage";

type CheckConclusion = "success" | "failure" | "neutral" | "action_required";

type CheckOutput = {
  title: string;
  summary: string;
};

type IssueComment = {
  html_url: string;
};

export type GitHubInstallation = {
  installationId: string;
  githubAccountId: string;
};

export type GitHubRepositoryIdentity = GitHubInstallation & {
  repositoryId: string;
  repositoryOwnerId: string;
  owner: string;
  repo: string;
  fullName: string;
};

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function appJwt(env: ServiceEnv): string {
  if (!env.githubAppId || !env.githubPrivateKey) {
    throw new Error("GitHub App credentials are missing. Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY.");
  }
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: env.githubAppId,
    }),
  );
  const data = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(data).sign(env.githubPrivateKey);
  return `${data}.${b64url(signature)}`;
}

function decimalId(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`GitHub returned an invalid ${label}`);
  }
  return String(value);
}

function safeIdNumber(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive decimal string`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new Error(`${label} cannot be represented exactly as a JavaScript number`);
  }
  return parsed;
}

export class GitHubRequestError extends Error {
  constructor(readonly status: number | null, readonly retryable = status === null || status === 429 || (status >= 500 && status <= 599)) {
    super(status === null
      ? "GitHub network request failed (retryable)"
      : `GitHub API request failed: HTTP ${status} (${retryable ? "retryable; retry after GitHub recovers or its rate limit resets" : "check App permissions, installation and repository access"})`);
    this.name = "GitHubRequestError";
  }
}

async function githubFetch<T>(
  path: string,
  opts: {
    token: string;
    method?: string;
    body?: unknown;
  },
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }).catch(() => { throw new GitHubRequestError(null); });
  if (!response.ok) {
    const rateLimited = response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
    // Never include response bodies or request headers: they may contain credentials.
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubRequestError(response.status, rateLimited || response.status === 429 || response.status >= 500);
  }
  return (await response.json()) as T;
}

export class GitHubClient {
  #env: ServiceEnv;
  #installationTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(env: ServiceEnv) {
    this.#env = env;
  }

  async inspectInstallation(installationId: string): Promise<GitHubInstallation> {
    const requestedId = safeIdNumber(installationId, "GitHub installation ID");
    const installation = await githubFetch<{ id: number; account?: { id?: number } }>(
      `/app/installations/${requestedId}`,
      { token: appJwt(this.#env) },
    );
    const returnedId = decimalId(installation.id, "installation ID");
    if (returnedId !== installationId) {
      throw new Error("GitHub returned a different installation ID");
    }
    return {
      installationId: returnedId,
      githubAccountId: decimalId(installation.account?.id, "installation account ID"),
    };
  }

  async resolveRepository(owner: string, repo: string): Promise<GitHubRepositoryIdentity> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const jwt = appJwt(this.#env);
    const installation = await githubFetch<{ id: number; account?: { id?: number } }>(
      `/repos/${encodedOwner}/${encodedRepo}/installation`,
      { token: jwt },
    );
    const installationId = decimalId(installation.id, "installation ID");
    const githubAccountId = decimalId(installation.account?.id, "installation account ID");
    const access = await githubFetch<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { token: jwt, method: "POST", body: {} },
    );
    const repository = await githubFetch<{
      id: number;
      name: string;
      full_name: string;
      owner?: { id?: number; login?: string };
    }>(`/repos/${encodedOwner}/${encodedRepo}`, { token: access.token });
    const repositoryOwnerId = decimalId(repository.owner?.id, "repository owner ID");
    if (repositoryOwnerId !== githubAccountId) {
      throw new Error("GitHub repository owner does not match the installation account");
    }
    return {
      installationId,
      githubAccountId,
      repositoryId: decimalId(repository.id, "repository ID"),
      repositoryOwnerId,
      owner: repository.owner?.login ?? owner,
      repo: repository.name,
      fullName: repository.full_name,
    };
  }

  async inspectInstallationRepository(
    installationId: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryIdentity> {
    const installation = await this.inspectInstallation(installationId);
    const repository = await this.resolveRepository(owner, repo);
    if (
      repository.installationId !== installation.installationId ||
      repository.githubAccountId !== installation.githubAccountId
    ) {
      throw new Error("The selected repository does not belong to the requested installation");
    }

    // End-to-end check that the app can mint a token restricted to this exact
    // repository. The token remains opaque and is never returned or logged.
    await githubFetch<{ token: string }>(
      `/app/installations/${installation.installationId}/access_tokens`,
      {
        token: appJwt(this.#env),
        method: "POST",
        body: {
          repository_ids: [safeIdNumber(repository.repositoryId, "GitHub repository ID")],
        },
      },
    );
    return repository;
  }

  async tokenForRepo(owner: string, repo: string): Promise<string> {
    if (this.#env.githubToken) return this.#env.githubToken;
    const cacheKey = `${owner}/${repo}`;
    const cached = this.#installationTokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const jwt = appJwt(this.#env);
    const installation = await githubFetch<{ id: number }>(`/repos/${owner}/${repo}/installation`, {
      token: jwt,
    });
    const access = await githubFetch<{ token: string; expires_at: string }>(
      `/app/installations/${installation.id}/access_tokens`,
      { token: jwt, method: "POST", body: {} },
    );
    this.#installationTokens.set(cacheKey, {
      token: access.token,
      expiresAt: new Date(access.expires_at).getTime(),
    });
    return access.token;
  }

  async createCheckRun(input: RunStartRequest & { cycleKey: string }): Promise<number> {
    const token = await this.tokenForRepo(input.owner, input.repo);
    const check = await githubFetch<{ id: number }>(
      `/repos/${input.owner}/${input.repo}/check-runs`,
      {
        token,
        method: "POST",
        body: {
          name: GITHUB_CHECK_NAME,
          head_sha: input.headSha,
          status: "in_progress",
          external_id: input.cycleKey,
          output: {
            title: "Feature-Rec: analyzing",
            summary: "Feature-Rec is checking whether this PR needs Slack validation.",
          },
        },
      },
    );
    return check.id;
  }

  async updateCheckRun(
    cycle: Pick<CycleRecord, "owner" | "repo" | "checkRunId">,
    input: {
      status?: "in_progress" | "completed";
      conclusion?: CheckConclusion;
      output: CheckOutput;
    },
  ): Promise<void> {
    if (!cycle.checkRunId) return;
    const token = await this.tokenForRepo(cycle.owner, cycle.repo);
    await githubFetch(`/repos/${cycle.owner}/${cycle.repo}/check-runs/${cycle.checkRunId}`, {
      token,
      method: "PATCH",
      body: {
        status: input.status ?? (input.conclusion ? "completed" : "in_progress"),
        conclusion: input.conclusion,
        completed_at: input.conclusion ? new Date().toISOString() : undefined,
        output: input.output,
      },
    });
  }

  async comment(cycle: CycleRecord, body: string): Promise<string> {
    const token = await this.tokenForRepo(cycle.owner, cycle.repo);
    const comment = await githubFetch<IssueComment>(
      `/repos/${cycle.owner}/${cycle.repo}/issues/${cycle.prNumber}/comments`,
      {
        token,
        method: "POST",
        body: { body },
      },
    );
    return comment.html_url;
  }

  // Retry policy: the comment POST is single-shot (retrying after a post-write
  // timeout would duplicate PR comments — not idempotent); the check-run PATCH
  // is idempotent and retried. Callers must NOT wrap these methods in withRetry.
  async accept(cycle: CycleRecord): Promise<void> {
    const commentUrl = await this.comment(
      cycle,
      renderTemplate(GITHUB_ACCEPT_COMMENT, {
        pr_author: cycle.prAuthor,
      }).trim(),
    );
    await withRetry(() =>
      this.updateCheckRun(cycle, {
        conclusion: "success",
        output: {
          title: "Feature-Rec: accepted",
          summary: `Validation passed. See PR conversation: ${commentUrl}`,
        },
      }),
    );
  }

  async reject(cycle: CycleRecord, reviewComment: string): Promise<void> {
    const commentUrl = await this.comment(
      cycle,
      renderTemplate(GITHUB_REJECT_COMMENT, {
        review_comment: reviewComment,
        pr_author: cycle.prAuthor,
      }).trim(),
    );
    await withRetry(() =>
      this.updateCheckRun(cycle, {
        conclusion: "action_required",
        output: {
          title: "Feature-Rec: rejected",
          summary: `Validation requested changes. See PR conversation: ${commentUrl}`,
        },
      }),
    );
  }
}
