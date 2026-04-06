/**
 * Error-deploy correlation engine.
 * Cross-references Sentry error groups with deployment timestamps
 * to identify which deploy likely introduced which error.
 *
 * Confidence scoring:
 *   high   — error first_seen within 15 min of deploy ready_at
 *   medium — error first_seen within 1 hour of deploy ready_at
 *   low    — error first_seen within 6 hours of deploy ready_at
 *   none   — > 6 hours apart (no correlation)
 */

import type { ErrorEvent, Deployment, Correlation } from "../types.js";

const CONFIDENCE_THRESHOLDS = {
  high: 15 * 60 * 1000,      // 15 minutes in ms
  medium: 60 * 60 * 1000,    // 1 hour in ms
  low: 6 * 60 * 60 * 1000,   // 6 hours in ms
};

export function correlate(
  errors: ErrorEvent[],
  deployments: Deployment[]
): Correlation[] {
  // Only consider deployments that are ready (have a ready_at timestamp)
  const readyDeploys = deployments
    .filter((d) => d.ready_at !== null)
    .sort(
      (a, b) =>
        new Date(b.ready_at!).getTime() - new Date(a.ready_at!).getTime()
    );

  if (readyDeploys.length === 0 || errors.length === 0) {
    return [];
  }

  const correlations: Correlation[] = [];

  for (const error of errors) {
    const errorTime = new Date(error.first_seen).getTime();

    // Find the most recent deploy that happened BEFORE this error was first seen
    const candidateDeploy = readyDeploys.find((d) => {
      const deployTime = new Date(d.ready_at!).getTime();
      return deployTime <= errorTime;
    });

    if (!candidateDeploy) continue;

    const deployTime = new Date(candidateDeploy.ready_at!).getTime();
    const diffMs = errorTime - deployTime;

    let confidence: Correlation["confidence"] | null = null;

    if (diffMs <= CONFIDENCE_THRESHOLDS.high) {
      confidence = "high";
    } else if (diffMs <= CONFIDENCE_THRESHOLDS.medium) {
      confidence = "medium";
    } else if (diffMs <= CONFIDENCE_THRESHOLDS.low) {
      confidence = "low";
    }

    if (!confidence) continue; // No correlation — error is too far from any deploy

    const diffMin = Math.round(diffMs / 60000);
    const diffLabel =
      diffMin < 60
        ? `${diffMin} minutes`
        : `${Math.round(diffMin / 60)} hours`;

    correlations.push({
      error_group_id: error.id,
      error_title: error.title,
      probable_deploy: {
        id: candidateDeploy.id,
        url: candidateDeploy.url,
        created_at: candidateDeploy.created_at,
        branch: candidateDeploy.branch,
      },
      confidence,
      reason: `Error first seen ${diffLabel} after deploy to ${candidateDeploy.branch} (${candidateDeploy.environment})`,
    });
  }

  return correlations;
}

/**
 * Build a human-readable timeline merging error first-seen events and deploy ready events.
 */
export function buildTimeline(
  errors: ErrorEvent[],
  deployments: Deployment[]
): { timestamp: string; type: "error" | "deploy"; description: string }[] {
  const events: { timestamp: string; type: "error" | "deploy"; description: string }[] = [];

  for (const error of errors) {
    events.push({
      timestamp: error.first_seen,
      type: "error",
      description: `[${error.level.toUpperCase()}] ${error.title} (${error.count} occurrences)`,
    });
  }

  for (const deploy of deployments) {
    const ts = deploy.ready_at ?? deploy.created_at;
    events.push({
      timestamp: ts,
      type: "deploy",
      description: `Deploy ${deploy.id} to ${deploy.environment} (${deploy.branch}) — ${deploy.state}`,
    });
  }

  return events.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}
