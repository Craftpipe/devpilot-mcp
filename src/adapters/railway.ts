/**
 * Railway GraphQL API adapter.
 * Implements DeployProvider interface using Railway's public GraphQL API.
 * Auth: Bearer RAILWAY_TOKEN
 */

import type {
  DeployProvider,
  Deployment,
  DeployOpts,
  LogEntry,
  EnvVar,
  CostReport,
} from "./types.js";

const GRAPHQL_URL = "https://backboard.railway.app/graphql/v2";

// --- GraphQL helpers ---

interface GQLResponse<T> {
  data?: T;
  errors?: { message: string; locations?: unknown[]; path?: unknown[] }[];
}

// --- Railway API shapes ---

interface RailwayDeployment {
  id: string;
  status: string;
  staticUrl?: string;
  createdAt: string;
  updatedAt: string;
  environment?: { name: string };
  service?: { name: string };
  meta?: { branch?: string };
}

interface RailwayDeploymentsData {
  deployments: {
    edges: { node: RailwayDeployment }[];
  };
}

interface RailwayDeploymentCreateData {
  deploymentCreate: RailwayDeployment;
}

interface RailwayLogLine {
  timestamp: string;
  message: string;
  severity?: string;
}

interface RailwayLogsData {
  deploymentLogs: RailwayLogLine[];
}

interface RailwayVariable {
  name: string;
  serviceId?: string;
  environmentId?: string;
}

interface RailwayVariablesData {
  variables: Record<string, string>;
}

// --- Adapter ---

export class RailwayAdapter implements DeployProvider {
  readonly name = "railway";
  private readonly token: string;

  constructor() {
    const token = process.env.RAILWAY_TOKEN;
    if (!token) {
      throw new Error(
        "RAILWAY_TOKEN not set. Add it to your environment to use Railway tools. " +
          "Get a token at https://railway.app/account/tokens"
      );
    }
    this.token = token;
  }

  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const fetchOpts: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    };

    let res = await fetch(GRAPHQL_URL, fetchOpts);

    // Rate limit handling
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 60000)
        : 10000;
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetch(GRAPHQL_URL, fetchOpts);

      if (res.status === 429) {
        throw new Error(
          `Railway rate limited. Retry after ${retryAfter ?? "unknown"} seconds.`
        );
      }
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Railway API error (${res.status}): ${res.statusText} — ${body}`
      );
    }

    const json = (await res.json()) as GQLResponse<T>;

    if (json.errors && json.errors.length > 0) {
      const msgs = json.errors.map((e) => e.message).join(", ");
      throw new Error(`Railway GraphQL error: ${msgs}`);
    }

    if (!json.data) {
      throw new Error("Railway GraphQL: no data in response");
    }

    return json.data;
  }

  private mapState(
    raw: string
  ): "building" | "ready" | "error" | "canceled" | "queued" {
    switch (raw?.toUpperCase()) {
      case "SUCCESS":
        return "ready";
      case "DEPLOYING":
      case "BUILDING":
        return "building";
      case "FAILED":
      case "CRASHED":
        return "error";
      case "REMOVED":
        return "canceled";
      case "WAITING":
      default:
        return "queued";
    }
  }

  private toDeployment(d: RailwayDeployment): Deployment {
    return {
      id: d.id,
      url: d.staticUrl ?? "",
      state: this.mapState(d.status),
      branch: d.meta?.branch ?? "unknown",
      environment: d.environment?.name ?? "production",
      created_at: d.createdAt,
      ready_at: d.status?.toUpperCase() === "SUCCESS" ? d.updatedAt : null,
      provider: "railway",
    };
  }

  async getDeployments(projectId: string): Promise<Deployment[]> {
    const query = `
      query GetDeployments($projectId: String!) {
        deployments(input: { projectId: $projectId }, first: 10) {
          edges {
            node {
              id
              status
              staticUrl
              createdAt
              updatedAt
              meta
              environment { name }
              service { name }
            }
          }
        }
      }
    `;

    const data = await this.graphql<RailwayDeploymentsData>(query, {
      projectId,
    });
    return (data.deployments.edges ?? []).map((e) => this.toDeployment(e.node));
  }

  async triggerDeploy(projectId: string, opts: DeployOpts): Promise<Deployment> {
    const mutation = `
      mutation TriggerDeploy($projectId: String!, $environmentId: String) {
        deploymentCreate(input: {
          projectId: $projectId,
          environmentId: $environmentId
        }) {
          id
          status
          staticUrl
          createdAt
          updatedAt
          meta
          environment { name }
        }
      }
    `;

    const data = await this.graphql<RailwayDeploymentCreateData>(mutation, {
      projectId,
      environmentId: opts.environment,
    });

    return this.toDeployment(data.deploymentCreate);
  }

  async rollback(projectId: string, deploymentId: string): Promise<Deployment> {
    const mutation = `
      mutation RollbackDeploy($id: String!, $projectId: String!) {
        deploymentRedeploy(id: $id) {
          id
          status
          staticUrl
          createdAt
          updatedAt
          meta
          environment { name }
        }
      }
    `;

    const data = await this.graphql<{ deploymentRedeploy: RailwayDeployment }>(
      mutation,
      { id: deploymentId, projectId }
    );

    return this.toDeployment(data.deploymentRedeploy);
  }

  async getLogs(deploymentId: string, lines: number): Promise<LogEntry[]> {
    const query = `
      query GetLogs($deploymentId: String!, $limit: Int!) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp
          message
          severity
        }
      }
    `;

    const data = await this.graphql<RailwayLogsData>(query, {
      deploymentId,
      limit: lines,
    });

    return (data.deploymentLogs ?? []).map((l) => ({
      timestamp: l.timestamp,
      message: l.message,
      level: l.severity,
    }));
  }

  async getEnvironmentVars(projectId: string): Promise<EnvVar[]> {
    const query = `
      query GetVariables($projectId: String!) {
        variables(projectId: $projectId)
      }
    `;

    const data = await this.graphql<RailwayVariablesData>(query, { projectId });

    // Railway returns variables as a flat object — we can only see keys
    return Object.keys(data.variables ?? {}).map((key) => ({
      key,
      target: ["production"],
    }));
  }

  async getCosts(_timeframe: string): Promise<CostReport> {
    // Railway doesn't have a public costs API yet — return placeholder
    return {
      total_cost: 0,
      currency: "USD",
      breakdown: [],
      trend: "unavailable",
      suggestions: [
        "Railway billing API is not publicly available. Check your dashboard at https://railway.app/account/billing",
      ],
    };
  }
}

// Unused type kept for compatibility
export type { RailwayVariable };
