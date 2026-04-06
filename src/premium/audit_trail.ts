/**
 * audit_trail — Pro tool to query the DevPilot audit log.
 * Input: { timeframe?, action_type? }
 * Returns: audit entries filtered by timeframe and/or action_type.
 */

import { requirePro } from "./gate.js";
import { AuditLog } from "../lib/audit.js";
import type { AuditEntry } from "../types.js";

export interface AuditTrailInput {
  timeframe?: "1d" | "7d" | "30d";
  action_type?: string;
  limit?: number;
}

export interface AuditTrailOutput {
  timeframe: string | null;
  action_type: string | null;
  total: number;
  entries: AuditEntry[];
}

export async function auditTrail(
  input: AuditTrailInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  requirePro("audit_trail");

  // Use a dedicated audit instance for the query; also writes a log of this query
  const audit = new AuditLog();
  const start = Date.now();

  try {
    const rows = audit.query({
      timeframe: input.timeframe,
      tool_name: input.action_type,
      limit: input.limit ?? 50,
    });

    // Map AuditRow (success as integer) to AuditEntry (success as boolean)
    const entries: AuditEntry[] = rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      tool_name: row.tool_name,
      provider: row.provider,
      input_summary: row.input_summary,
      result_summary: row.result_summary,
      success: Boolean(row.success),
      duration_ms: row.duration_ms ?? undefined,
    }));

    const result: AuditTrailOutput = {
      timeframe: input.timeframe ?? null,
      action_type: input.action_type ?? null,
      total: entries.length,
      entries,
    };

    // Log this audit_trail query itself
    audit.log({
      tool_name: "audit_trail",
      provider: "",
      input_summary: audit.sanitize({
        timeframe: input.timeframe,
        action_type: input.action_type,
        limit: input.limit,
      }),
      result_summary: `${entries.length} audit entries returned`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "audit_trail",
      provider: "",
      input_summary: audit.sanitize({
        timeframe: input.timeframe,
        action_type: input.action_type,
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
