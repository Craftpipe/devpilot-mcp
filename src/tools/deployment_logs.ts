/**
 * deployment_logs tool — fetch deployment or runtime logs from Vercel or Railway.
 * Input: { provider: "vercel" | "railway", deployment_id?: string, lines?: number }
 * Returns: log entries with timestamps and log level.
 */

import { VercelAdapter } from "../adapters/vercel.js";
import { RailwayAdapter } from "../adapters/railway.js";
import { getAuditLog } from "../lib/audit.js";
import type { LogEntry } from "../types.js";

export interface DeploymentLogsInput {
  provider: "vercel" | "railway";
  project_id?: string;
  deployment_id?: string;
  lines?: number;
}

export interface DeploymentLogsOutput {
  provider: string;
  deployment_id: string;
  lines_requested: number;
  logs: LogEntry[];
}

export async function deploymentLogs(
  input: DeploymentLogsInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const audit = getAuditLog();
  const start = Date.now();

  const lines = input.lines ?? 100;
  // Track the resolved deployment ID so it is accessible in the catch block.
  let resolvedDeploymentId = input.deployment_id ?? "";

  try {
    const adapter =
      input.provider === "vercel"
        ? new VercelAdapter()
        : new RailwayAdapter();

    // Auto-resolve deployment ID: if not provided, fetch the most recent deployment.
    if (!resolvedDeploymentId) {
      if (!input.project_id) {
        // Preserve backward-compatible error message for callers that omit both fields.
        throw new Error(
          "deployment_id is required for deployment_logs. " +
            "Provide the deployment ID from deploy_status or trigger_deploy, " +
            "or supply project_id to auto-fetch the latest deployment."
        );
      }
      const recent = await adapter.getDeployments(input.project_id);
      if (!recent.length) {
        throw new Error(
          `No deployments found for project "${input.project_id}" on ${input.provider}.`
        );
      }
      resolvedDeploymentId = recent[0].id;
    }

    const logs = await adapter.getLogs(resolvedDeploymentId, lines);

    const result: DeploymentLogsOutput = {
      provider: input.provider,
      deployment_id: resolvedDeploymentId,
      lines_requested: lines,
      logs,
    };

    audit.log({
      tool_name: "deployment_logs",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        deployment_id: resolvedDeploymentId,
        lines,
      }),
      result_summary: `${logs.length} log entries fetched`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "deployment_logs",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        deployment_id: resolvedDeploymentId,
        lines,
      }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - start,
    });

    throw err;
  }
}
