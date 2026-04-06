/**
 * GitHub Actions API adapter.
 * Implements CIProvider interface using GitHub REST API v3.
 * Auth: token GITHUB_TOKEN
 * Uses polling (not sleep) to find newly triggered workflow runs.
 */

import type { CIProvider, WorkflowRun } from "./types.js";

const BASE_URL = "https://api.github.com";

// --- GitHub API response shapes ---

interface GHWorkflow {
  id: number;
  name: string;
  path: string;
}

interface GHWorkflowsResponse {
  total_count: number;
  workflows: GHWorkflow[];
}

interface GHWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  name?: string;
  workflow_id?: number;
  created_at: string;
  updated_at: string;
}

interface GHRunsResponse {
  total_count: number;
  workflow_runs: GHWorkflowRun[];
}

// --- Adapter ---

export class GitHubActionsAdapter implements CIProvider {
  readonly name = "github-actions";
  private readonly token: string;

  constructor() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN not set. Add it to your environment to use GitHub Actions tools. " +
          "Create a PAT at https://github.com/settings/tokens with actions:write scope."
      );
    }
    this.token = token;
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const fetchOpts: RequestInit = {
      ...opts,
      headers: {
        Authorization: `token ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        ...(opts?.headers ?? {}),
      },
    };

    let res = await fetch(url, fetchOpts);

    // GitHub rate limit handling (uses 429 OR 403 with x-ratelimit headers)
    if (res.status === 429 || res.status === 403) {
      const retryAfter = res.headers.get("retry-after");
      const rateLimitReset = res.headers.get("x-ratelimit-reset");

      let waitMs: number;
      if (retryAfter) {
        waitMs = Math.min(parseInt(retryAfter, 10) * 1000, 60000);
      } else if (rateLimitReset) {
        waitMs = Math.min(
          Math.max(parseInt(rateLimitReset, 10) * 1000 - Date.now(), 1000),
          60000
        );
      } else {
        waitMs = 10000;
      }

      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetch(url, fetchOpts);

      if (res.status === 429 || res.status === 403) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        throw new Error(
          `GitHub API rate limited (remaining: ${remaining ?? 0}). ` +
            `Wait ${Math.ceil(waitMs / 1000)}s or use a token with higher limits.`
        );
      }
    }

    if (!res.ok && res.status !== 204) {
      const body = await res.text();
      throw new Error(
        `GitHub API error (${res.status}): ${res.statusText} — ${body}`
      );
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  private mapRun(run: GHWorkflowRun): WorkflowRun {
    const status = run.status as "queued" | "in_progress" | "completed";
    const conclusion = run.conclusion as WorkflowRun["conclusion"];
    return {
      id: run.id,
      status,
      conclusion,
      html_url: run.html_url,
      workflow_name: run.name ?? "unknown",
      created_at: run.created_at,
      updated_at: run.updated_at,
    };
  }

  async listWorkflows(repo: string): Promise<{ id: number; name: string; path: string }[]> {
    const data = await this.request<GHWorkflowsResponse>(
      `/repos/${repo}/actions/workflows`
    );
    return (data.workflows ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
    }));
  }

  async triggerWorkflow(
    repo: string,
    workflow: string,
    branch: string,
    inputs?: Record<string, string>
  ): Promise<WorkflowRun> {
    // Resolve workflow: can be a filename, id, or "ci.yml"
    const workflowRef = workflow || "ci.yml";

    // Record trigger time BEFORE dispatching for polling comparison
    const triggerTime = new Date().toISOString();

    // POST workflow_dispatch — returns 204 No Content on success
    await this.request<Record<string, unknown>>(
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowRef)}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: branch || "main",
          inputs: inputs ?? {},
        }),
      }
    );

    // Poll for the newly created run (Fix 11: polling instead of sleep)
    return this.pollForNewRun(repo, workflowRef, branch, triggerTime);
  }

  private async pollForNewRun(
    repo: string,
    workflow: string,
    branch: string,
    triggerTime: string
  ): Promise<WorkflowRun> {
    let attempts = 0;
    const maxAttempts = 15;

    while (attempts < maxAttempts) {
      const runs = await this.getWorkflowRuns(repo, workflow, branch);
      const recent = runs.find((r) => r.created_at >= triggerTime);
      if (recent) {
        return this.mapRun(recent);
      }
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }

    // If we can't find the run after polling, return a placeholder
    return {
      id: 0,
      status: "queued",
      conclusion: null,
      html_url: `https://github.com/${repo}/actions`,
      workflow_name: workflow,
      created_at: triggerTime,
      updated_at: triggerTime,
    };
  }

  private async getWorkflowRuns(
    repo: string,
    workflow: string,
    branch?: string
  ): Promise<GHWorkflowRun[]> {
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : "";
    const data = await this.request<GHRunsResponse>(
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=10${branchParam}`
    );
    return data.workflow_runs ?? [];
  }

  async getWorkflowStatus(repo: string, runId: number): Promise<WorkflowRun> {
    const run = await this.request<GHWorkflowRun>(
      `/repos/${repo}/actions/runs/${runId}`
    );
    return this.mapRun(run);
  }
}
