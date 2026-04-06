#!/usr/bin/env node
/**
 * DevPilot MCP — Unified DevOps lifecycle MCP server.
 * Entry point — MCP server setup and tool registration.
 *
 * This file wires together all adapters, tools, and the audit trail.
 * Full tool implementations live in src/tools/ and src/premium/.
 */

// Re-export types for consumers
export type {
  Deployment,
  ErrorEvent,
  WorkflowRun,
  LogEntry,
  HealthResult,
  AuditEntry,
  Correlation,
} from "./types.js";

// Re-export adapter types
export type { DeployProvider, ErrorProvider, CIProvider, HealthProvider } from "./adapters/types.js";

// Re-export lib modules
export { AuditLog } from "./lib/audit.js";
export { correlate, buildTimeline } from "./lib/correlator.js";

// Re-export adapters
export { VercelAdapter } from "./adapters/vercel.js";
export { RailwayAdapter } from "./adapters/railway.js";
export { SentryAdapter } from "./adapters/sentry.js";
export { GitHubActionsAdapter } from "./adapters/github-actions.js";
export { HealthAdapter } from "./adapters/health.js";

// Re-export premium gate
export { isPro, requirePro } from "./premium/gate.js";

// MCP server entrypoint — to be implemented in subsequent tasks
// import { Server } from "@modelcontextprotocol/sdk/server/index.js";
// import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
