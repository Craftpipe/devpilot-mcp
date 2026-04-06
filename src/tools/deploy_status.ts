/**
 * deploy_status tool — get recent deployments from Vercel or Railway.
 * Input: { provider: "vercel" | "railway", project_id: string }
 * Returns: list of deployments with status, URL, created time.
 */

import { VercelAdapter } from "../adapters/vercel.js";
import { RailwayAdapter } from "../adapters/railway.js";
import { AuditLog } from "../lib/audit.js";
import type { Deployment } from "../types.js";

export interface DeployStatusInput {
  provider: "vercel" | "railway";
  project_id: string;
}

export interface DeployStatusOutput {
  provider: string;
  project_id: string;
  deployments: Deployment[];
}

export async function deployStatus(
  input: DeployStatusInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const audit = new AuditLog();
  const start = Date.now();

  try {
    const adapter =
      input.provider === "vercel"
        ? new VercelAdapter()
        : new RailwayAdapter();

    const deployments = await adapter.getDeployments(input.project_id);

    const result: DeployStatusOutput = {
      provider: input.provider,
      project_id: input.project_id,
      deployments,
    };

    audit.log({
      tool_name: "deploy_status",
      provider: input.provider,
      input_summary: audit.sanitize({ provider: input.provider, project_id: input.project_id }),
      result_summary: `${deployments.length} deployments found`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "deploy_status",
      provider: input.provider,
      input_summary: audit.sanitize({ provider: input.provider, project_id: input.project_id }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - start,
    });

    throw err;
  } finally {
    audit.close();
  }
}
