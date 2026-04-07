/**
 * trigger_deploy tool — trigger a deployment on Vercel or Railway.
 * Input: { provider: "vercel" | "railway", project_id: string, branch?: string, environment?: string }
 * Returns: deployment ID, URL, status.
 */

import { VercelAdapter } from "../adapters/vercel.js";
import { RailwayAdapter } from "../adapters/railway.js";
import { getAuditLog } from "../lib/audit.js";
import type { Deployment, DeployOpts } from "../types.js";

export interface TriggerDeployInput {
  provider: "vercel" | "railway";
  project_id: string;
  branch?: string;
  environment?: "production" | "preview" | "staging";
}

export interface TriggerDeployOutput {
  provider: string;
  deployment: Deployment;
}

export async function triggerDeploy(
  input: TriggerDeployInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const audit = getAuditLog();
  const start = Date.now();

  try {
    const adapter =
      input.provider === "vercel"
        ? new VercelAdapter()
        : new RailwayAdapter();

    const opts: DeployOpts = {
      branch: input.branch,
      environment: input.environment,
    };

    const deployment = await adapter.triggerDeploy(input.project_id, opts);

    const result: TriggerDeployOutput = {
      provider: input.provider,
      deployment,
    };

    audit.log({
      tool_name: "trigger_deploy",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        project_id: input.project_id,
        branch: input.branch,
        environment: input.environment,
      }),
      result_summary: `Deployment ${deployment.id} triggered — status: ${deployment.state}`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "trigger_deploy",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        project_id: input.project_id,
        branch: input.branch,
        environment: input.environment,
      }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - start,
    });

    throw err;
  }
}
