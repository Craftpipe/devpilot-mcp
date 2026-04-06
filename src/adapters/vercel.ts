/**
 * Vercel REST API adapter.
 * Implements DeployProvider interface using Vercel's v6/v13 REST API.
 * Auth: Bearer VERCEL_TOKEN
 */

import type {
  DeployProvider,
  Deployment,
  DeployOpts,
  LogEntry,
  EnvVar,
  CostReport,
} from "./types.js";

const BASE_URL = "https://api.vercel.com";

// --- Vercel API response shapes ---

interface VercelDeployment {
  uid: string;
  url: string;
  state: string;
  meta?: { githubCommitRef?: string };
  target?: string;
  createdAt?: number;
  ready?: number;
  name?: string;
}

interface VercelDeploymentsResponse {
  deployments: VercelDeployment[];
}

interface VercelLogEvent {
  created?: number;
  text?: string;
  level?: string;
  source?: string;
  type?: string;
}

interface VercelEnvVar {
  key: string;
  target?: string[];
}

interface VercelEnvResponse {
  envs: VercelEnvVar[];
}

// --- Adapter ---

export class VercelAdapter implements DeployProvider {
  readonly name = "vercel";
  private readonly token: string;

  constructor() {
    const token = process.env.VERCEL_TOKEN;
    if (!token) {
      throw new Error(
        "VERCEL_TOKEN not set. Add it to your environment to use Vercel tools. " +
          "Get a token at https://vercel.com/account/tokens"
      );
    }
    this.token = token;
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const fetchOpts: RequestInit = {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(opts?.headers ?? {}),
      },
    };

    let res = await fetch(url, fetchOpts);

    // Rate limit handling: wait and retry once
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 60000)
        : 10000;
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetch(url, fetchOpts);

      if (res.status === 429) {
        throw new Error(
          `Vercel rate limited. Retry after ${retryAfter ?? "unknown"} seconds. ` +
            `Check usage at https://vercel.com/account/usage`
        );
      }
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Vercel API error (${res.status}): ${res.statusText} — ${body}`
      );
    }

    return res.json() as Promise<T>;
  }

  private mapState(
    raw: string
  ): "building" | "ready" | "error" | "canceled" | "queued" {
    switch (raw?.toUpperCase()) {
      case "READY":
        return "ready";
      case "BUILDING":
      case "INITIALIZING":
        return "building";
      case "ERROR":
        return "error";
      case "CANCELED":
        return "canceled";
      case "QUEUED":
      default:
        return "queued";
    }
  }

  private toDeployment(d: VercelDeployment): Deployment {
    return {
      id: d.uid,
      url: d.url ? `https://${d.url}` : "",
      state: this.mapState(d.state),
      branch: d.meta?.githubCommitRef ?? "unknown",
      environment: d.target ?? "production",
      created_at: d.createdAt
        ? new Date(d.createdAt).toISOString()
        : new Date().toISOString(),
      ready_at: d.ready ? new Date(d.ready).toISOString() : null,
      provider: "vercel",
    };
  }

  async getDeployments(projectId: string): Promise<Deployment[]> {
    const data = await this.request<VercelDeploymentsResponse>(
      `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=10`
    );
    return (data.deployments ?? []).map((d) => this.toDeployment(d));
  }

  async triggerDeploy(projectId: string, opts: DeployOpts): Promise<Deployment> {
    const body = {
      name: projectId,
      target: opts.environment ?? "production",
      gitSource: opts.branch
        ? { type: "github", ref: opts.branch }
        : undefined,
    };

    const d = await this.request<VercelDeployment>("/v13/deployments", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return this.toDeployment(d);
  }

  async rollback(projectId: string, deploymentId: string): Promise<Deployment> {
    // POST /v10/projects/{projectId}/promote/{deploymentId}
    const d = await this.request<VercelDeployment>(
      `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return this.toDeployment(d);
  }

  async getLogs(deploymentId: string, lines: number): Promise<LogEntry[]> {
    const events = await this.request<VercelLogEvent[]>(
      `/v3/deployments/${encodeURIComponent(deploymentId)}/events`
    );

    const entries: LogEntry[] = (events ?? [])
      .filter((e) => e.text)
      .map((e) => ({
        timestamp: e.created
          ? new Date(e.created).toISOString()
          : new Date().toISOString(),
        message: e.text ?? "",
        level: e.level,
        source: e.source ?? e.type,
      }));

    return entries.slice(-lines);
  }

  async getEnvironmentVars(projectId: string): Promise<EnvVar[]> {
    const data = await this.request<VercelEnvResponse>(
      `/v9/projects/${encodeURIComponent(projectId)}/env`
    );
    return (data.envs ?? []).map((e) => ({
      key: e.key,
      target: e.target ?? [],
    }));
  }

  async getCosts(_timeframe: string): Promise<CostReport> {
    // Vercel usage API — returns raw usage data
    const data = await this.request<Record<string, unknown>>("/v1/usage");
    return {
      total_cost: 0,
      currency: "USD",
      breakdown: [],
      trend: "stable",
      suggestions: [],
      ...(data as Partial<CostReport>),
    };
  }
}
