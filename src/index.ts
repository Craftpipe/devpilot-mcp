#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Free tools
import { deployStatus } from './tools/deploy_status.js';
import { triggerDeploy } from './tools/trigger_deploy.js';
import { getErrors } from './tools/get_errors.js';
import { runTests } from './tools/run_tests.js';
import { deploymentLogs } from './tools/deployment_logs.js';
import { healthCheck } from './tools/health_check.js';

// Pro tools
import { rollbackDeploy } from './premium/rollback_deploy.js';
import { incidentReport } from './premium/incident_report.js';
import { deployPipeline } from './premium/deploy_pipeline.js';
import { costMonitor } from './premium/cost_monitor.js';
import { environmentSync } from './premium/environment_sync.js';
import { auditTrail } from './premium/audit_trail.js';

const server = new McpServer({ name: 'devpilot-mcp', version: '1.0.0' });

// ─── Free Tools ───────────────────────────────────────────────────────────────

server.tool(
  'deploy_status',
  'Get recent deployments from Vercel or Railway. Returns a list of deployments with state, URL, branch, and timing.',
  {
    provider: z.enum(['vercel', 'railway']).describe('Deployment provider'),
    project_id: z.string().describe('Project ID or name on the provider'),
  },
  async (args) => {
    return deployStatus(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'trigger_deploy',
  'Trigger a new deployment on Vercel or Railway for the specified project and branch.',
  {
    provider: z.enum(['vercel', 'railway']).describe('Deployment provider'),
    project_id: z.string().describe('Project ID or name on the provider'),
    branch: z.string().optional().describe('Branch to deploy (default: main)'),
    environment: z
      .enum(['production', 'preview', 'staging'])
      .optional()
      .describe('Target environment (default: production)'),
  },
  async (args) => {
    return triggerDeploy(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'get_errors',
  'Fetch recent error events from Sentry with title, count, level, and timing. Requires SENTRY_TOKEN and SENTRY_ORG env vars.',
  {
    provider: z.literal('sentry').describe('Error tracking provider'),
    project_slug: z.string().describe('Sentry project slug — find at https://sentry.io/settings/'),
    timeframe: z
      .enum(['1h', '24h', '7d'])
      .optional()
      .describe('Time window to query (default: 24h)'),
  },
  async (args) => {
    return getErrors(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'run_tests',
  'Trigger a GitHub Actions CI workflow and return the run ID, URL, and status.',
  {
    provider: z.literal('github-actions').describe('CI provider'),
    repo: z.string().describe('GitHub repository in owner/repo format'),
    workflow: z.string().optional().describe('Workflow file name (default: ci.yml)'),
    branch: z.string().optional().describe('Branch to run the workflow on (default: main)'),
  },
  async (args) => {
    return runTests(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'deployment_logs',
  'Fetch deployment or runtime logs for a specific deployment from Vercel or Railway. Omit deployment_id to auto-fetch logs for the latest deployment (requires project_id).',
  {
    provider: z.enum(['vercel', 'railway']).describe('Deployment provider'),
    project_id: z
      .string()
      .optional()
      .describe('Project ID or name — required when deployment_id is omitted, to auto-fetch the latest deployment'),
    deployment_id: z
      .string()
      .optional()
      .describe('Deployment ID from deploy_status or trigger_deploy (omit to use latest deployment)'),
    lines: z.number().int().positive().optional().describe('Maximum lines to return (default: 100)'),
  },
  async (args) => {
    return deploymentLogs(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'health_check',
  'Check the HTTP status of one or more URLs. Returns up/down status, response time, and status code per URL.',
  {
    urls: z
      .array(z.string())
      .min(1)
      .describe('List of URLs to check (must start with http:// or https://)'),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Request timeout in milliseconds (default: 5000)'),
  },
  async (args) => {
    return healthCheck(args) as Promise<CallToolResult>;
  },
);

// ─── Pro Tools ────────────────────────────────────────────────────────────────

server.tool(
  'rollback_deploy',
  '[Pro] Roll back a Vercel or Railway project to the previous deployment. Optionally specify a target deployment ID.',
  {
    provider: z.enum(['vercel', 'railway']).describe('Deployment provider'),
    project_id: z.string().describe('Project ID or name on the provider'),
    deployment_id: z
      .string()
      .optional()
      .describe('Specific deployment ID to roll back to (default: previous deployment)'),
  },
  async (args) => {
    return rollbackDeploy(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'incident_report',
  '[Pro] Correlate Sentry errors with recent deployments to identify the probable cause of an incident. Returns a timeline and confidence-scored correlations.',
  {
    project_slug: z.string().describe('Sentry project slug'),
    vercel_project_id: z
      .string()
      .optional()
      .describe('Vercel project ID or name (required for deployment correlation; defaults to project_slug if omitted)'),
    timeframe: z
      .enum(['1h', '6h', '24h', '7d'])
      .describe('Time window to analyse for the incident'),
    include_deploys: z
      .boolean()
      .optional()
      .describe('Include Vercel deployment correlation (default: true)'),
  },
  async (args) => {
    return incidentReport(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'deploy_pipeline',
  '[Pro] Orchestrate a full deploy pipeline: run tests → trigger deploy → health check → error check. Aborts immediately on any step failure.',
  {
    repo: z.string().describe('GitHub repository in owner/repo format'),
    branch: z.string().describe('Branch to deploy'),
    provider: z.enum(['vercel', 'railway']).describe('Deployment provider'),
    project_id: z.string().describe('Project ID or name on the provider'),
    test_workflow: z
      .string()
      .optional()
      .describe('GitHub Actions workflow file to run before deploying (e.g. ci.yml)'),
    health_url: z
      .string()
      .optional()
      .describe('URL to health-check after deployment succeeds'),
    sentry_project_slug: z
      .string()
      .optional()
      .describe('Sentry project slug to check for new errors after deployment'),
  },
  async (args) => {
    return deployPipeline(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'cost_monitor',
  '[Pro] Retrieve infrastructure cost breakdown and trend for a Vercel or Railway project over a given timeframe.',
  {
    provider: z.enum(['vercel', 'railway']).describe('Deployment provider'),
    timeframe: z
      .enum(['7d', '30d', '90d'])
      .optional()
      .describe('Reporting period (default: 30d)'),
  },
  async (args) => {
    return costMonitor(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'environment_sync',
  '[Pro] Compare environment variables across two or more environments on Vercel or Railway. Returns a diff showing which keys are missing — values are never exposed.',
  {
    provider: z.enum(['vercel', 'railway']).describe('Deployment provider'),
    project_id: z
      .string()
      .optional()
      .describe('Project ID or name on the provider (recommended — when omitted, each environment name is used as the project identifier)'),
    environments: z
      .array(z.string())
      .min(2)
      .describe('List of environment names to compare (e.g. ["production", "preview"])'),
  },
  async (args) => {
    return environmentSync(args) as Promise<CallToolResult>;
  },
);

server.tool(
  'audit_trail',
  '[Pro] Query the DevPilot audit log to review all tool calls, providers used, and outcomes.',
  {
    timeframe: z
      .enum(['1d', '7d', '30d'])
      .optional()
      .describe('Filter entries within this time window'),
    action_type: z
      .string()
      .optional()
      .describe('Filter by tool name (e.g. "deploy_pipeline", "rollback_deploy")'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of entries to return (default: 50)'),
  },
  async (args) => {
    return auditTrail(args) as Promise<CallToolResult>;
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
