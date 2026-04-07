/**
 * run_tests tool — trigger a CI workflow via GitHub Actions.
 * Input: { provider: "github-actions", repo: string, workflow?: string, branch?: string }
 * Returns: workflow run ID, URL, status.
 */

import { GitHubActionsAdapter } from "../adapters/github-actions.js";
import { getAuditLog } from "../lib/audit.js";
import type { WorkflowRun } from "../types.js";

export interface RunTestsInput {
  provider: "github-actions";
  repo: string;
  workflow?: string;
  branch?: string;
}

export interface RunTestsOutput {
  provider: string;
  repo: string;
  run: WorkflowRun;
}

export async function runTests(
  input: RunTestsInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const audit = getAuditLog();
  const start = Date.now();

  const workflow = input.workflow ?? "ci.yml";
  const branch = input.branch ?? "main";

  try {
    const adapter = new GitHubActionsAdapter();

    const run = await adapter.triggerWorkflow(input.repo, workflow, branch);

    const result: RunTestsOutput = {
      provider: input.provider,
      repo: input.repo,
      run,
    };

    audit.log({
      tool_name: "run_tests",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        repo: input.repo,
        workflow,
        branch,
      }),
      result_summary: `Workflow run ${run.id} — status: ${run.status}`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "run_tests",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        repo: input.repo,
        workflow,
        branch,
      }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - start,
    });

    throw err;
  }
}
