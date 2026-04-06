/**
 * cost_monitor — Pro tool to get deployment costs from a provider.
 * Input: { provider, timeframe? }
 * Returns: cost breakdown and trend.
 */

import { requirePro } from "./gate.js";
import { VercelAdapter } from "../adapters/vercel.js";
import { RailwayAdapter } from "../adapters/railway.js";
import { AuditLog } from "../lib/audit.js";
import type { CostReport } from "../types.js";

export interface CostMonitorInput {
  provider: "vercel" | "railway";
  timeframe?: "7d" | "30d" | "90d";
}

export interface CostMonitorOutput {
  provider: string;
  timeframe: string;
  report: CostReport;
}

export async function costMonitor(
  input: CostMonitorInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  requirePro("cost_monitor");

  const audit = new AuditLog();
  const start = Date.now();
  const timeframe = input.timeframe ?? "30d";

  try {
    const adapter =
      input.provider === "vercel"
        ? new VercelAdapter()
        : new RailwayAdapter();

    const report = await adapter.getCosts(timeframe);

    const result: CostMonitorOutput = {
      provider: input.provider,
      timeframe,
      report,
    };

    audit.log({
      tool_name: "cost_monitor",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        timeframe,
      }),
      result_summary: `Cost report: ${report.currency} ${report.total_cost} (${report.trend})`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "cost_monitor",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        timeframe,
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
