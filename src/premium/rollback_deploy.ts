/**
 * rollback_deploy — Pro tool to roll back a deployment to the previous version.
 * Input: { provider, project_id, deployment_id? }
 * Returns: the new (rollback) deployment object.
 */

import { requirePro } from "./gate.js";
import { VercelAdapter } from "../adapters/vercel.js";
import { RailwayAdapter } from "../adapters/railway.js";
import { AuditLog } from "../lib/audit.js";
import type { Deployment } from "../types.js";

export interface RollbackDeployInput {
  provider: "vercel" | "railway";
  project_id: string;
  deployment_id?: string;
}

export interface RollbackDeployOutput {
  provider: string;
  project_id: string;
  deployment: Deployment;
}

export async function rollbackDeploy(
  input: RollbackDeployInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  requirePro("rollback_deploy");

  const audit = new AuditLog();
  const start = Date.now();

  const deploymentId = input.deployment_id ?? "";

  try {
    const adapter =
      input.provider === "vercel"
        ? new VercelAdapter()
        : new RailwayAdapter();

    // If no deployment_id provided, get the second-most-recent (i.e. previous) deployment
    let targetDeploymentId = deploymentId;
    if (!targetDeploymentId) {
      const deployments = await adapter.getDeployments(input.project_id);
      const previous = deployments[1]; // index 0 = current, index 1 = previous
      if (!previous) {
        throw new Error(
          "No previous deployment found to roll back to. " +
            "At least two deployments are required for rollback."
        );
      }
      targetDeploymentId = previous.id;
    }

    const deployment = await adapter.rollback(input.project_id, targetDeploymentId);

    const result: RollbackDeployOutput = {
      provider: input.provider,
      project_id: input.project_id,
      deployment,
    };

    audit.log({
      tool_name: "rollback_deploy",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        project_id: input.project_id,
        deployment_id: targetDeploymentId,
      }),
      result_summary: `Rolled back to deployment ${deployment.id} — status: ${deployment.state}`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "rollback_deploy",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        project_id: input.project_id,
        deployment_id: deploymentId,
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
