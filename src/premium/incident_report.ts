/**
 * incident_report — Pro tool to correlate errors with deployments.
 * Input: { project_slug, timeframe, include_deploys? }
 * Uses correlator to match Sentry errors with recent deployments.
 * Returns: timeline, correlations with confidence scores.
 */

import { requirePro } from "./gate.js";
import { SentryAdapter } from "../adapters/sentry.js";
import { VercelAdapter } from "../adapters/vercel.js";
import { AuditLog } from "../lib/audit.js";
import { correlate, buildTimeline } from "../lib/correlator.js";
import type { Correlation } from "../types.js";

export interface IncidentReportInput {
  project_slug: string;
  timeframe: "1h" | "6h" | "24h" | "7d";
  include_deploys?: boolean;
}

export interface IncidentReportOutput {
  project_slug: string;
  timeframe: string;
  timeline: { timestamp: string; type: "error" | "deploy"; description: string }[];
  correlations: Correlation[];
  summary: {
    total_errors: number;
    total_deploys: number;
    correlated: number;
    high_confidence: number;
  };
}

export async function incidentReport(
  input: IncidentReportInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  requirePro("incident_report");

  if (!input.project_slug) {
    throw new Error(
      "project_slug is required for incident_report. " +
        "Find your project slug at https://sentry.io/settings/"
    );
  }

  const audit = new AuditLog();
  const start = Date.now();

  try {
    const sentry = new SentryAdapter();
    const errors = await sentry.getErrors(input.project_slug, input.timeframe, 50);

    // Fetch recent deployments for correlation (uses Vercel if token is available)
    let deployments: import("../types.js").Deployment[] = [];
    if (input.include_deploys !== false) {
      try {
        const vercel = new VercelAdapter();
        deployments = await vercel.getDeployments(input.project_slug);
      } catch {
        // Deployments are optional — if Vercel token not set, skip silently
        deployments = [];
      }
    }

    const correlations = correlate(errors, deployments);
    const timeline = buildTimeline(errors, deployments);

    const result: IncidentReportOutput = {
      project_slug: input.project_slug,
      timeframe: input.timeframe,
      timeline,
      correlations,
      summary: {
        total_errors: errors.length,
        total_deploys: deployments.length,
        correlated: correlations.length,
        high_confidence: correlations.filter((c) => c.confidence === "high").length,
      },
    };

    audit.log({
      tool_name: "incident_report",
      provider: "sentry",
      input_summary: audit.sanitize({
        project_slug: input.project_slug,
        timeframe: input.timeframe,
        include_deploys: input.include_deploys,
      }),
      result_summary: `${errors.length} errors, ${correlations.length} correlated with deploys`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "incident_report",
      provider: "sentry",
      input_summary: audit.sanitize({
        project_slug: input.project_slug,
        timeframe: input.timeframe,
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
