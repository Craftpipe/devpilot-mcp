/**
 * deployment_logs tool — fetch deployment or runtime logs from Vercel or Railway.
 * Input: { provider: "vercel" | "railway", deployment_id?: string, lines?: number }
 * Returns: log entries with timestamps and log level.
 */

import { VercelAdapter } from "../adapters/vercel.js";
import { RailwayAdapter } from "../adapters/railway.js";
import { AuditLog } from "../lib/audit.js";
import type { LogEntry } from "../types.js";

export interface DeploymentLogsInput {
  provider: "vercel" | "railway";
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
  const audit = new AuditLog();
  const start = Date.now();

  const deploymentId = input.deployment_id ?? "";
  const lines = input.lines ?? 100;

  if (!deploymentId) {
    throw new Error(
      "deployment_id is required for deployment_logs. " +
        "Provide the deployment ID from deploy_status or trigger_deploy."
    );
  }

  try {
    const adapter =
      input.provider === "vercel"
        ? new VercelAdapter()
        : new RailwayAdapter();

    const logs = await adapter.getLogs(deploymentId, lines);

    const result: DeploymentLogsOutput = {
      provider: input.provider,
      deployment_id: deploymentId,
      lines_requested: lines,
      logs,
    };

    audit.log({
      tool_name: "deployment_logs",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        deployment_id: deploymentId,
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
        deployment_id: deploymentId,
        lines,
      }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - start,
    });

    throw err;
  } finally {
    audit.close();
  }
}
