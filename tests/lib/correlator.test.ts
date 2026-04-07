/**
 * Correlator tests.
 * Verifies confidence scoring thresholds, timeline building, and edge cases.
 */

import { describe, it, expect } from "vitest";
import { correlate, buildTimeline } from "../../src/lib/correlator.js";
import type { ErrorEvent, Deployment } from "../../src/types.js";

// Helper to create a deploy at a given ISO timestamp
function makeDeploy(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "dpl_default",
    url: "https://app.vercel.app",
    state: "ready",
    branch: "main",
    environment: "production",
    created_at: "2024-01-15T10:00:00.000Z",
    ready_at: "2024-01-15T10:00:00.000Z",
    provider: "vercel",
    ...overrides,
  };
}

// Helper to create an error that first appeared at a given ISO timestamp
function makeError(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    id: "issue_default",
    title: "Test error",
    culprit: "src/test.ts",
    count: 1,
    first_seen: "2024-01-15T10:05:00.000Z",
    last_seen: "2024-01-15T10:05:00.000Z",
    level: "error",
    short_id: "APP-001",
    ...overrides,
  };
}

describe("correlate()", () => {
  describe("confidence thresholds", () => {
    it("high: error within 15 minutes of deploy", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T10:05:00.000Z" }); // 5 min

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(1);
      expect(correlations[0]!.confidence).toBe("high");
    });

    it("high: error exactly at 15-minute boundary", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T10:15:00.000Z" }); // exactly 15 min

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(1);
      expect(correlations[0]!.confidence).toBe("high");
    });

    it("medium: error between 15 minutes and 1 hour of deploy", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T10:45:00.000Z" }); // 45 min

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(1);
      expect(correlations[0]!.confidence).toBe("medium");
    });

    it("medium: error exactly at 1-hour boundary", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T11:00:00.000Z" }); // exactly 1h

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(1);
      expect(correlations[0]!.confidence).toBe("medium");
    });

    it("low: error between 1 hour and 6 hours of deploy", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T13:00:00.000Z" }); // 3 hours

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(1);
      expect(correlations[0]!.confidence).toBe("low");
    });

    it("low: error exactly at 6-hour boundary", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T16:00:00.000Z" }); // exactly 6h

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(1);
      expect(correlations[0]!.confidence).toBe("low");
    });

    it("none: error more than 6 hours after deploy — no correlation", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T00:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T10:00:00.000Z" }); // 10 hours

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(0);
    });

    it("none: error occurred BEFORE deploy — no correlation", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T12:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T10:00:00.000Z" }); // before deploy

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(0);
    });
  });

  describe("correlation shape", () => {
    it("includes error_group_id, error_title, probable_deploy, confidence, reason", () => {
      const deploy = makeDeploy({
        id: "dpl_shape",
        ready_at: "2024-01-15T10:00:00.000Z",
        branch: "main",
        environment: "production",
      });
      const error = makeError({
        id: "issue_shape",
        title: "Shape error",
        first_seen: "2024-01-15T10:10:00.000Z",
      });

      const correlations = correlate([error], [deploy]);
      expect(correlations[0]!.error_group_id).toBe("issue_shape");
      expect(correlations[0]!.error_title).toBe("Shape error");
      expect(correlations[0]!.probable_deploy.id).toBe("dpl_shape");
      expect(correlations[0]!.confidence).toBe("high");
      expect(correlations[0]!.reason).toContain("minutes");
    });

    it("reason labels >= 60 minutes in hours", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T12:00:00.000Z" }); // 2h

      const correlations = correlate([error], [deploy]);
      expect(correlations[0]!.reason).toContain("2 hours");
    });

    it("reason labels < 60 minutes in minutes", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error = makeError({ first_seen: "2024-01-15T10:07:00.000Z" }); // 7 min

      const correlations = correlate([error], [deploy]);
      expect(correlations[0]!.reason).toContain("7 minutes");
    });
  });

  describe("multiple errors and deploys", () => {
    it("correlates each error to the most recent deploy before it", () => {
      const deploy1 = makeDeploy({ id: "dpl_1", ready_at: "2024-01-15T08:00:00.000Z" });
      const deploy2 = makeDeploy({ id: "dpl_2", ready_at: "2024-01-15T12:00:00.000Z" });

      const error1 = makeError({ id: "err_1", first_seen: "2024-01-15T08:10:00.000Z" }); // after deploy1
      const error2 = makeError({ id: "err_2", first_seen: "2024-01-15T12:05:00.000Z" }); // after deploy2

      const correlations = correlate([error1, error2], [deploy1, deploy2]);
      expect(correlations).toHaveLength(2);

      const c1 = correlations.find((c) => c.error_group_id === "err_1");
      const c2 = correlations.find((c) => c.error_group_id === "err_2");

      expect(c1!.probable_deploy.id).toBe("dpl_1");
      expect(c2!.probable_deploy.id).toBe("dpl_2");
    });

    it("returns correlations for multiple errors against same deploy", () => {
      const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
      const error1 = makeError({ id: "err_a", first_seen: "2024-01-15T10:05:00.000Z" });
      const error2 = makeError({ id: "err_b", first_seen: "2024-01-15T10:08:00.000Z" });
      const error3 = makeError({ id: "err_c", first_seen: "2024-01-15T10:12:00.000Z" });

      const correlations = correlate([error1, error2, error3], [deploy]);
      expect(correlations).toHaveLength(3);
      correlations.forEach((c) => {
        expect(c.probable_deploy.id).toBe("dpl_default");
        expect(c.confidence).toBe("high");
      });
    });
  });

  describe("edge cases", () => {
    it("returns empty array when errors list is empty", () => {
      const deploy = makeDeploy();
      const correlations = correlate([], [deploy]);
      expect(correlations).toHaveLength(0);
    });

    it("returns empty array when deployments list is empty", () => {
      const error = makeError();
      const correlations = correlate([error], []);
      expect(correlations).toHaveLength(0);
    });

    it("returns empty array when both lists are empty", () => {
      const correlations = correlate([], []);
      expect(correlations).toHaveLength(0);
    });

    it("ignores deployments without ready_at (null)", () => {
      const deploy = makeDeploy({ ready_at: null });
      const error = makeError({ first_seen: "2024-01-15T10:05:00.000Z" });

      const correlations = correlate([error], [deploy]);
      expect(correlations).toHaveLength(0);
    });

    it("uses the most recent eligible deploy when multiple are available", () => {
      const olderDeploy = makeDeploy({ id: "dpl_old", ready_at: "2024-01-15T08:00:00.000Z" });
      const newerDeploy = makeDeploy({ id: "dpl_new", ready_at: "2024-01-15T10:00:00.000Z" });

      const error = makeError({ first_seen: "2024-01-15T10:05:00.000Z" }); // after both

      const correlations = correlate([error], [olderDeploy, newerDeploy]);
      expect(correlations).toHaveLength(1);
      expect(correlations[0]!.probable_deploy.id).toBe("dpl_new");
    });
  });
});

describe("buildTimeline()", () => {
  it("merges error and deploy events in chronological order", () => {
    const deploy = makeDeploy({
      id: "dpl_tl",
      created_at: "2024-01-15T10:00:00.000Z",
      ready_at: "2024-01-15T10:02:00.000Z",
    });
    const error = makeError({
      first_seen: "2024-01-15T10:05:00.000Z",
      title: "Timeline error",
      level: "error",
      count: 5,
    });

    const timeline = buildTimeline([error], [deploy]);
    expect(timeline.length).toBeGreaterThanOrEqual(2);

    const types = timeline.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).toContain("deploy");
  });

  it("sorts events chronologically (ascending)", () => {
    const deploy = makeDeploy({ ready_at: "2024-01-15T10:00:00.000Z" });
    const error1 = makeError({ id: "e1", first_seen: "2024-01-15T09:00:00.000Z" });
    const error2 = makeError({ id: "e2", first_seen: "2024-01-15T11:00:00.000Z" });

    const timeline = buildTimeline([error1, error2], [deploy]);
    const timestamps = timeline.map((e) => new Date(e.timestamp).getTime());

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  });

  it("uses ready_at for deploy timestamp when available", () => {
    const deploy = makeDeploy({
      id: "dpl_ready",
      created_at: "2024-01-15T10:00:00.000Z",
      ready_at: "2024-01-15T10:05:00.000Z",
    });

    const timeline = buildTimeline([], [deploy]);
    const deployEvent = timeline.find((e) => e.type === "deploy");
    expect(deployEvent!.timestamp).toBe("2024-01-15T10:05:00.000Z");
  });

  it("falls back to created_at when ready_at is null", () => {
    const deploy = makeDeploy({
      id: "dpl_noready",
      created_at: "2024-01-15T10:00:00.000Z",
      ready_at: null,
    });

    const timeline = buildTimeline([], [deploy]);
    const deployEvent = timeline.find((e) => e.type === "deploy");
    expect(deployEvent!.timestamp).toBe("2024-01-15T10:00:00.000Z");
  });

  it("error description includes level, title, and count", () => {
    const error = makeError({
      level: "error",
      title: "Specific error title",
      count: 42,
    });

    const timeline = buildTimeline([error], []);
    const errorEvent = timeline.find((e) => e.type === "error");
    expect(errorEvent!.description).toContain("ERROR");
    expect(errorEvent!.description).toContain("Specific error title");
    expect(errorEvent!.description).toContain("42");
  });

  it("deploy description includes id, environment, branch, and state", () => {
    const deploy = makeDeploy({
      id: "dpl_desc",
      environment: "staging",
      branch: "feature/test",
      state: "ready",
    });

    const timeline = buildTimeline([], [deploy]);
    const deployEvent = timeline.find((e) => e.type === "deploy");
    expect(deployEvent!.description).toContain("dpl_desc");
    expect(deployEvent!.description).toContain("staging");
    expect(deployEvent!.description).toContain("feature/test");
    expect(deployEvent!.description).toContain("ready");
  });

  it("returns empty array when both lists are empty", () => {
    const timeline = buildTimeline([], []);
    expect(timeline).toHaveLength(0);
  });
});
