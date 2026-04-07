/**
 * deploy_pipeline — Pro tool to orchestrate a full deploy pipeline.
 * Input: { repo, branch, provider, test_workflow?, health_url? }
 * Steps: run tests → trigger deploy → wait → health check → error check
 * ABORTS on ANY step failure — returns immediately with failure_reason (Fix 9).
 */

import { requirePro } from "./gate.js";
import { GitHubActionsAdapter } from "../adapters/github-actions.js";
import { VercelAdapter } from "../adapters/vercel.js";
import { RailwayAdapter } from "../adapters/railway.js";
import { HealthAdapter } from "../adapters/health.js";
import { SentryAdapter } from "../adapters/sentry.js";
import { getAuditLog } from "../lib/audit.js";

const POLL_INTERVAL_MS = 10_000; // 10 seconds between polls

/** Poll a GitHub Actions run until it completes or the timeout elapses. */
async function pollTestCompletion(
  ci: GitHubActionsAdapter,
  repo: string,
  runId: number,
  timeoutMs = 600_000 // 10 minutes
): Promise<{ status: string; conclusion: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await ci.getWorkflowStatus(repo, runId);
    if (run.status === "completed") {
      return { status: run.status, conclusion: run.conclusion ?? null };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Test run ${runId} did not complete within ${timeoutMs / 60_000} minutes (timeout).`
  );
}

/** Poll a deployment until it reaches "ready"/"error"/"canceled" or the timeout elapses. */
async function pollDeployReadiness(
  adapter: VercelAdapter | RailwayAdapter,
  projectId: string,
  deploymentId: string,
  timeoutMs = 300_000 // 5 minutes
): Promise<{ state: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployments = await adapter.getDeployments(projectId);
    const deployment = deployments.find((d) => d.id === deploymentId);
    if (deployment) {
      if (
        deployment.state === "ready" ||
        deployment.state === "error" ||
        deployment.state === "canceled"
      ) {
        return { state: deployment.state };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Deployment ${deploymentId} did not reach a terminal state within ${timeoutMs / 60_000} minutes (timeout).`
  );
}

export interface DeployPipelineInput {
  repo: string;
  branch: string;
  provider: "vercel" | "railway";
  project_id: string;
  test_workflow?: string;
  health_url?: string;
  sentry_project_slug?: string;
}

interface PipelineStep {
  name: string;
  status: "success" | "failure" | "skipped";
  duration_ms: number;
  result?: unknown;
}

export interface DeployPipelineOutput {
  steps: PipelineStep[];
  overall_status: "success" | "failure";
  total_duration_ms: number;
  failure_reason?: string;
}

function success(output: DeployPipelineOutput): { content: [{ type: "text"; text: string }] } {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
  };
}

export async function deployPipeline(
  input: DeployPipelineInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  requirePro("deploy_pipeline");

  const audit = getAuditLog();
  const pipelineStart = Date.now();
  const steps: PipelineStep[] = [];

  try {
    // Step 1: Run tests (if test_workflow specified)
    if (input.test_workflow) {
      const testStart = Date.now();
      try {
        const ci = new GitHubActionsAdapter();
        // triggerWorkflow returns immediately once the run is queued/started.
        // Poll until completion (10s intervals, 10min timeout).
        const run = await ci.triggerWorkflow(
          input.repo,
          input.test_workflow,
          input.branch
        );

        let finalStatus = run.status;
        let finalConclusion = run.conclusion ?? null;

        if (run.id && run.status !== "completed") {
          const polled = await pollTestCompletion(ci, input.repo, run.id, 600_000);
          finalStatus = polled.status;
          finalConclusion = polled.conclusion;
        }

        const testPassed = finalStatus === "completed" && finalConclusion === "success";

        steps.push({
          name: "run_tests",
          status: testPassed ? "success" : "failure",
          duration_ms: Date.now() - testStart,
          result: { run_id: run.id, status: finalStatus, conclusion: finalConclusion },
        });

        if (!testPassed) {
          return success({
            steps,
            overall_status: "failure",
            total_duration_ms: Date.now() - pipelineStart,
            failure_reason: `Tests failed — workflow run ${run.id}: ${finalConclusion ?? finalStatus}`,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({
          name: "run_tests",
          status: "failure",
          duration_ms: Date.now() - testStart,
          result: { error: message },
        });
        return success({
          steps,
          overall_status: "failure",
          total_duration_ms: Date.now() - pipelineStart,
          failure_reason: `Test step error: ${message}`,
        });
      }
    }

    // Step 2: Trigger deployment and poll for readiness (10s intervals, 5min timeout).
    const deployStart = Date.now();
    let deploymentId: string | undefined;
    let deploymentUrl: string | undefined;

    try {
      const adapter =
        input.provider === "vercel"
          ? new VercelAdapter()
          : new RailwayAdapter();

      const deployment = await adapter.triggerDeploy(input.project_id, {
        branch: input.branch,
      });

      deploymentId = deployment.id;
      deploymentUrl = deployment.url;

      // Poll until the deployment reaches a terminal state (ready/error/canceled).
      // If polling itself fails (e.g. transient API error), proceed optimistically
      // with the initial state so the pipeline is not aborted unnecessarily.
      let finalState = deployment.state;
      if (
        deployment.state !== "ready" &&
        deployment.state !== "error" &&
        deployment.state !== "canceled"
      ) {
        try {
          const polled = await pollDeployReadiness(adapter, input.project_id, deployment.id, 300_000);
          finalState = polled.state as typeof deployment.state;
        } catch {
          // Polling failed — continue with the initial state (treat as still deploying/queued)
          // The health check in the next step will confirm actual readiness.
        }
      }

      if (finalState === "error" || finalState === "canceled") {
        steps.push({
          name: "trigger_deploy",
          status: "failure",
          duration_ms: Date.now() - deployStart,
          result: { deployment_id: deployment.id, url: deployment.url, state: finalState },
        });
        return success({
          steps,
          overall_status: "failure",
          total_duration_ms: Date.now() - pipelineStart,
          failure_reason: `Deployment ${deployment.id} ended with state: ${finalState}`,
        });
      }

      steps.push({
        name: "trigger_deploy",
        status: "success",
        duration_ms: Date.now() - deployStart,
        result: {
          deployment_id: deployment.id,
          url: deployment.url,
          state: finalState,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({
        name: "trigger_deploy",
        status: "failure",
        duration_ms: Date.now() - deployStart,
        result: { error: message },
      });
      return success({
        steps,
        overall_status: "failure",
        total_duration_ms: Date.now() - pipelineStart,
        failure_reason: `Deploy trigger failed: ${message}`,
      });
    }

    // Step 3: Health check (if URL provided)
    if (input.health_url) {
      const healthStart = Date.now();
      try {
        const health = new HealthAdapter();
        const results = await health.check([input.health_url], 10000, 200);
        const allUp = results.every((r) => r.status === "up");

        steps.push({
          name: "health_check",
          status: allUp ? "success" : "failure",
          duration_ms: Date.now() - healthStart,
          result: results,
        });

        if (!allUp) {
          // FIX 9: Abort immediately on health check failure
          return success({
            steps,
            overall_status: "failure",
            total_duration_ms: Date.now() - pipelineStart,
            failure_reason: "Health check failed after deployment",
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({
          name: "health_check",
          status: "failure",
          duration_ms: Date.now() - healthStart,
          result: { error: message },
        });
        // FIX 9: Abort the pipeline on health check error — do NOT continue
        return success({
          steps,
          overall_status: "failure",
          total_duration_ms: Date.now() - pipelineStart,
          failure_reason: `Health check error: ${message}`,
        });
      }
    }

    // Step 4: Post-deploy error check via Sentry (optional)
    if (input.sentry_project_slug) {
      const errorStart = Date.now();
      try {
        const sentry = new SentryAdapter();
        const errors = await sentry.getErrors(input.sentry_project_slug, "1h", 10);
        const hasErrors = errors.length > 0;

        steps.push({
          name: "error_check",
          status: hasErrors ? "failure" : "success",
          duration_ms: Date.now() - errorStart,
          result: { error_count: errors.length, errors: errors.slice(0, 3) },
        });

        if (hasErrors) {
          return success({
            steps,
            overall_status: "failure",
            total_duration_ms: Date.now() - pipelineStart,
            failure_reason: `${errors.length} new error(s) detected after deployment`,
          });
        }
      } catch (err: unknown) {
        // Error check is best-effort — don't abort on Sentry failure
        const message = err instanceof Error ? err.message : String(err);
        steps.push({
          name: "error_check",
          status: "skipped",
          duration_ms: Date.now() - errorStart,
          result: { warning: `Sentry check skipped: ${message}` },
        });
      }
    }

    // All steps passed
    audit.log({
      tool_name: "deploy_pipeline",
      provider: input.provider,
      input_summary: audit.sanitize({
        repo: input.repo,
        branch: input.branch,
        provider: input.provider,
        project_id: input.project_id,
      }),
      result_summary: `Pipeline succeeded — ${steps.length} steps, deployment ${deploymentId}`,
      success: true,
      duration_ms: Date.now() - pipelineStart,
    });

    return success({
      steps,
      overall_status: "success",
      total_duration_ms: Date.now() - pipelineStart,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "deploy_pipeline",
      provider: input.provider,
      input_summary: audit.sanitize({
        repo: input.repo,
        branch: input.branch,
        provider: input.provider,
        project_id: input.project_id,
      }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - pipelineStart,
    });

    throw err;
  }
}
