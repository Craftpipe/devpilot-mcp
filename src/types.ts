/**
 * Shared TypeScript interfaces for DevPilot MCP.
 * These are the domain types used across tools, adapters, and lib modules.
 */

export interface Deployment {
  id: string;
  url: string;
  state: "building" | "ready" | "error" | "canceled" | "queued";
  branch: string;
  environment: string;
  created_at: string;
  ready_at: string | null;
  provider: string;
}

export interface ErrorEvent {
  id: string;
  title: string;
  culprit: string;
  count: number;
  first_seen: string;
  last_seen: string;
  level: string;
  short_id: string;
}

export interface WorkflowRun {
  id: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | null;
  html_url: string;
  workflow_name: string;
  created_at: string;
  updated_at: string;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  level?: string;
  source?: string;
}

export interface HealthResult {
  url: string;
  status: "up" | "down";
  status_code: number | null;
  response_time_ms: number;
  error?: string;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  tool_name: string;
  provider: string;
  input_summary: string;
  result_summary: string;
  success: boolean;
  duration_ms?: number;
}

export interface DeployOpts {
  branch?: string;
  environment?: "production" | "preview" | "staging";
}

export interface EnvVar {
  key: string;
  target: string[];
}

export interface CostReport {
  total_cost: number;
  currency: string;
  breakdown: { resource: string; cost: number; usage: string }[];
  trend: string;
  suggestions: string[];
}

export interface ErrorDetail extends ErrorEvent {
  stack_trace: string;
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
}

export interface Correlation {
  error_group_id: string;
  error_title: string;
  probable_deploy: {
    id: string;
    url: string;
    created_at: string;
    branch: string;
  };
  confidence: "high" | "medium" | "low";
  reason: string;
}
