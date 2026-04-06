/**
 * Provider adapter interfaces — all external service adapters implement these.
 * This ensures tools remain provider-agnostic.
 */

import type {
  Deployment,
  DeployOpts,
  LogEntry,
  EnvVar,
  CostReport,
  ErrorEvent,
  ErrorDetail,
  WorkflowRun,
  HealthResult,
} from "../types.js";

export type { Deployment, DeployOpts, LogEntry, EnvVar, CostReport, ErrorEvent, ErrorDetail, WorkflowRun, HealthResult };

export interface DeployProvider {
  name: string;
  getDeployments(projectId: string): Promise<Deployment[]>;
  triggerDeploy(projectId: string, opts: DeployOpts): Promise<Deployment>;
  rollback(projectId: string, deploymentId: string): Promise<Deployment>;
  getLogs(deploymentId: string, lines: number): Promise<LogEntry[]>;
  getEnvironmentVars(projectId: string): Promise<EnvVar[]>;
  getCosts(timeframe: string): Promise<CostReport>;
}

export interface ErrorProvider {
  name: string;
  getErrors(projectSlug: string, timeframe: string, limit: number): Promise<ErrorEvent[]>;
  getErrorDetails(errorId: string): Promise<ErrorDetail>;
}

export interface CIProvider {
  name: string;
  triggerWorkflow(
    repo: string,
    workflow: string,
    branch: string,
    inputs?: Record<string, string>
  ): Promise<WorkflowRun>;
  getWorkflowStatus(repo: string, runId: number): Promise<WorkflowRun>;
  listWorkflows(repo: string): Promise<{ id: number; name: string; path: string }[]>;
}

export interface HealthProvider {
  check(urls: string[], timeout: number, expectedStatus: number): Promise<HealthResult[]>;
}
