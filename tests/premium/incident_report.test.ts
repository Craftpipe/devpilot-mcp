/**
 * incident_report tests.
 * - Test with correlated errors + deploys
 * - Test with no correlations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { incidentReport } from "../../src/premium/incident_report.js";
import { AuditLog } from "../../src/lib/audit.js";

// Use in-memory audit log in tests
vi.mock("../../src/lib/audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/audit.js")>();
  class MockAuditLog extends actual.AuditLog {
    constructor() {
      super(":memory:");
    }
  }
  return {
    ...actual,
    AuditLog: MockAuditLog,
    getAuditLog: () => new MockAuditLog(),
    resetAuditLogSingleton: () => {},
  };
});

function setProLicense() {
  process.env.PRO_LICENSE = "CPK-test-license-key";
}

describe("incidentReport()", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    setProLicense();
    process.env.SENTRY_AUTH_TOKEN = "test-sentry-token";
    process.env.SENTRY_ORG = "test-org";
    process.env.VERCEL_TOKEN = "test-vercel-token";
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.PRO_LICENSE;
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_ORG;
    delete process.env.VERCEL_TOKEN;
    vi.restoreAllMocks();
  });

  describe("throws without Pro license", () => {
    it("throws requirePro error when PRO_LICENSE is not set", async () => {
      delete process.env.PRO_LICENSE;
      await expect(
        incidentReport({
          project_slug: "my-app",
          timeframe: "24h",
        })
      ).rejects.toThrow("[incident_report] requires a Pro license");
    });
  });

  describe("requires project_slug", () => {
    it("throws when project_slug is empty string", async () => {
      await expect(
        incidentReport({
          project_slug: "",
          timeframe: "24h",
        })
      ).rejects.toThrow("project_slug is required");
    });
  });

  describe("with correlated errors and deployments", () => {
    it("returns correlations when errors occurred shortly after a deploy", async () => {
      const deployReadyAt = "2024-01-15T10:00:00.000Z";
      const errorFirstSeen = "2024-01-15T10:05:00.000Z"; // 5 min after deploy = high confidence

      // Mock Sentry errors
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "issue_001",
              title: "TypeError: Cannot read property of undefined",
              culprit: "app/components/Button.tsx",
              count: "42",
              firstSeen: errorFirstSeen,
              lastSeen: "2024-01-15T11:00:00.000Z",
              level: "error",
              shortId: "MY-APP-001",
            },
          ],
        },
      });

      // Mock Vercel deployments
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_abc123",
                url: "my-app.vercel.app",
                state: "READY",
                meta: { githubCommitRef: "main" },
                target: "production",
                createdAt: new Date("2024-01-15T09:58:00.000Z").getTime(),
                ready: new Date(deployReadyAt).getTime(),
              },
            ],
          },
        },
      });

      const result = await incidentReport({
        project_slug: "my-app",
        timeframe: "24h",
        include_deploys: true,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.project_slug).toBe("my-app");
      expect(parsed.timeframe).toBe("24h");
      expect(parsed.summary.total_errors).toBe(1);
      expect(parsed.summary.total_deploys).toBe(1);
      expect(parsed.summary.correlated).toBe(1);
      expect(parsed.summary.high_confidence).toBe(1);

      expect(parsed.correlations).toHaveLength(1);
      expect(parsed.correlations[0].confidence).toBe("high");
      expect(parsed.correlations[0].error_group_id).toBe("issue_001");
      expect(parsed.correlations[0].probable_deploy.id).toBe("dpl_abc123");
      expect(parsed.correlations[0].reason).toContain("5 minutes");

      // Timeline should contain both error and deploy events
      expect(parsed.timeline.length).toBeGreaterThanOrEqual(2);
      const types = parsed.timeline.map((e: { type: string }) => e.type);
      expect(types).toContain("error");
      expect(types).toContain("deploy");
    });

    it("returns medium confidence when error occurred within 1 hour of deploy", async () => {
      const deployReadyAt = "2024-01-15T10:00:00.000Z";
      const errorFirstSeen = "2024-01-15T10:45:00.000Z"; // 45 min after = medium

      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "issue_002",
              title: "UnhandledPromiseRejection: fetch failed",
              culprit: "api/handler.ts",
              count: "8",
              firstSeen: errorFirstSeen,
              lastSeen: "2024-01-15T12:00:00.000Z",
              level: "warning",
              shortId: "MY-APP-002",
            },
          ],
        },
      });

      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_medium",
                url: "my-app-medium.vercel.app",
                state: "READY",
                meta: { githubCommitRef: "feature/x" },
                target: "production",
                createdAt: new Date("2024-01-15T09:55:00.000Z").getTime(),
                ready: new Date(deployReadyAt).getTime(),
              },
            ],
          },
        },
      });

      const result = await incidentReport({
        project_slug: "my-app",
        timeframe: "24h",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.correlations).toHaveLength(1);
      expect(parsed.correlations[0].confidence).toBe("medium");
      expect(parsed.summary.high_confidence).toBe(0);
    });
  });

  describe("with no correlations", () => {
    it("returns empty correlations when no deployments exist", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "issue_003",
              title: "ReferenceError: x is not defined",
              culprit: "utils/helper.ts",
              count: "3",
              firstSeen: "2024-01-15T10:00:00.000Z",
              lastSeen: "2024-01-15T10:30:00.000Z",
              level: "error",
              shortId: "MY-APP-003",
            },
          ],
        },
      });

      // No deployments
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: { body: { deployments: [] } },
      });

      const result = await incidentReport({
        project_slug: "my-app",
        timeframe: "24h",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.correlations).toHaveLength(0);
      expect(parsed.summary.correlated).toBe(0);
      expect(parsed.summary.total_errors).toBe(1);
      expect(parsed.summary.total_deploys).toBe(0);
    });

    it("returns empty correlations when no errors exist", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { body: [] },
      });

      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_no_errs",
                url: "no-errors.vercel.app",
                state: "READY",
                meta: { githubCommitRef: "main" },
                target: "production",
                createdAt: Date.now() - 3600000,
                ready: Date.now() - 3600000 + 120000,
              },
            ],
          },
        },
      });

      const result = await incidentReport({
        project_slug: "my-app",
        timeframe: "24h",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.correlations).toHaveLength(0);
      expect(parsed.summary.total_errors).toBe(0);
      expect(parsed.summary.total_deploys).toBe(1);
    });

    it("returns no correlation when error occurred more than 6 hours after deploy", async () => {
      const deployReadyAt = "2024-01-15T00:00:00.000Z";
      const errorFirstSeen = "2024-01-15T10:00:00.000Z"; // 10 hours after — no correlation

      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "issue_old",
              title: "Old error",
              culprit: "old.ts",
              count: "1",
              firstSeen: errorFirstSeen,
              lastSeen: errorFirstSeen,
              level: "error",
              shortId: "MY-APP-OLD",
            },
          ],
        },
      });

      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_old",
                url: "old.vercel.app",
                state: "READY",
                meta: { githubCommitRef: "main" },
                target: "production",
                createdAt: new Date("2024-01-14T23:58:00.000Z").getTime(),
                ready: new Date(deployReadyAt).getTime(),
              },
            ],
          },
        },
      });

      const result = await incidentReport({
        project_slug: "my-app",
        timeframe: "24h",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.correlations).toHaveLength(0);
      expect(parsed.summary.correlated).toBe(0);
    });

    it("works with include_deploys: false — skips deployment fetch entirely", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "issue_004",
              title: "Some error",
              culprit: "some.ts",
              count: "5",
              firstSeen: "2024-01-15T10:00:00.000Z",
              lastSeen: "2024-01-15T10:10:00.000Z",
              level: "error",
              shortId: "MY-APP-004",
            },
          ],
        },
      });

      const result = await incidentReport({
        project_slug: "my-app",
        timeframe: "1h",
        include_deploys: false,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.correlations).toHaveLength(0);
      expect(parsed.summary.total_deploys).toBe(0);
      expect(parsed.summary.total_errors).toBe(1);
    });
  });

  describe("audit logging", () => {
    it("creates an audit log entry on success", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { body: [] },
      });

      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: { body: { deployments: [] } },
      });

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await incidentReport({
        project_slug: "my-app",
        timeframe: "7d",
      });

      // At least one log call for the incident_report itself
      const incidentCall = logSpy.mock.calls.find(
        (call) => call[0].tool_name === "incident_report"
      );
      expect(incidentCall).toBeDefined();
      expect(incidentCall![0].success).toBe(true);
      expect(incidentCall![0].provider).toBe("sentry");

      logSpy.mockRestore();
    });
  });
});
