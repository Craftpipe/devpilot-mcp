/**
 * get_errors tool — fetch recent errors with stack traces from Sentry.
 * Input: { provider: "sentry", project_slug: string, timeframe?: "1h" | "24h" | "7d" }
 * Returns: list of error events with title, count, level, and timing.
 * Note: project_slug is REQUIRED.
 */

import { SentryAdapter } from "../adapters/sentry.js";
import { getAuditLog } from "../lib/audit.js";
import type { ErrorEvent } from "../types.js";

export interface GetErrorsInput {
  provider: "sentry";
  project_slug: string;
  timeframe?: "1h" | "24h" | "7d";
}

export interface GetErrorsOutput {
  provider: string;
  project_slug: string;
  timeframe: string;
  errors: ErrorEvent[];
}

export async function getErrors(
  input: GetErrorsInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const audit = getAuditLog();
  const start = Date.now();

  if (!input.project_slug) {
    throw new Error(
      "project_slug is required for get_errors. " +
        "Find your project slug at https://sentry.io/settings/"
    );
  }

  const timeframe = input.timeframe ?? "24h";

  try {
    const adapter = new SentryAdapter();

    const errors = await adapter.getErrors(input.project_slug, timeframe, 25);

    const result: GetErrorsOutput = {
      provider: input.provider,
      project_slug: input.project_slug,
      timeframe,
      errors,
    };

    audit.log({
      tool_name: "get_errors",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        project_slug: input.project_slug,
        timeframe,
      }),
      result_summary: `${errors.length} errors found in ${timeframe}`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "get_errors",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        project_slug: input.project_slug,
        timeframe,
      }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - start,
    });

    throw err;
  }
}
