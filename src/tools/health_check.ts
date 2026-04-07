/**
 * health_check tool — check HTTP status of one or more URLs.
 * Input: { urls: string[], timeout?: number }
 * Returns: status per URL (up/down, response time, status code).
 * Uses AbortController for timeout handling (Fix 5).
 */

import { HealthAdapter } from "../adapters/health.js";
import { getAuditLog } from "../lib/audit.js";
import type { HealthResult } from "../types.js";

export interface HealthCheckInput {
  urls: string[];
  timeout?: number;
}

export interface HealthCheckOutput {
  checked_at: string;
  timeout_ms: number;
  results: HealthResult[];
  summary: {
    total: number;
    up: number;
    down: number;
  };
}

export async function healthCheck(
  input: HealthCheckInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const audit = getAuditLog();
  const start = Date.now();

  const timeout = input.timeout ?? 5000;

  try {
    const adapter = new HealthAdapter();

    const results = await adapter.check(input.urls, timeout, 200);

    const up = results.filter((r) => r.status === "up").length;
    const down = results.filter((r) => r.status === "down").length;

    const result: HealthCheckOutput = {
      checked_at: new Date().toISOString(),
      timeout_ms: timeout,
      results,
      summary: {
        total: results.length,
        up,
        down,
      },
    };

    audit.log({
      tool_name: "health_check",
      provider: "http",
      input_summary: audit.sanitize({
        urls: input.urls,
        timeout,
      }),
      result_summary: `${up}/${results.length} URLs up`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "health_check",
      provider: "http",
      input_summary: audit.sanitize({
        urls: input.urls,
        timeout,
      }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - start,
    });

    throw err;
  }
}
