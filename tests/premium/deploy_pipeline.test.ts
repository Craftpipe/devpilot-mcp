/**
 * deploy_pipeline tests.
 * - Test successful pipeline (all steps pass)
 * - Test pipeline aborts on health check failure (Fix 9)
 * - Test pipeline aborts on test failure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { deployPipeline } from "../../src/premium/deploy_pipeline.js";
import { AuditLog } from "../../src/lib/audit.js";

// Use in-memory audit log in tests
vi.mock("../../src/lib/audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/audit.js")>();
  return {
    ...actual,
    AuditLog: class MockAuditLog extends actual.AuditLog {
      constructor() {
        super(":memory:");
      }
    },
  };
});

// Helper to set the Pro license
function setProLicense() {
  process.env.PRO_LICENSE = "CPK-test-license-key";
}

describe("deployPipeline()", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    setProLicense();
    process.env.VERCEL_TOKEN = "test-vercel-token";
    process.env.GITHUB_TOKEN = "test-github-token";
    process.env.RAILWAY_TOKEN = "test-railway-token";
    process.env.SENTRY_AUTH_TOKEN = "test-sentry-token";
    process.env.SENTRY_ORG = "test-org";
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.PRO_LICENSE;
    delete process.env.VERCEL_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.RAILWAY_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_ORG;
    vi.restoreAllMocks();
  });

  describe("throws without Pro license", () => {
    it("throws requirePro error when PRO_LICENSE is not set", async () => {
      delete process.env.PRO_LICENSE;
      await expect(
        deployPipeline({
          repo: "org/repo",
          branch: "main",
          provider: "vercel",
          project_id: "prj_test",
        })
      ).rejects.toThrow("[deploy_pipeline] requires a Pro license");
    });
  });

  describe("successful pipeline — no test workflow, no health check", () => {
    it("runs only trigger_deploy step and succeeds", async () => {
      // Mock Vercel trigger deploy
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_success_001",
            url: "my-app.vercel.app",
            state: "QUEUED",
            meta: { githubCommitRef: "main" },
            target: "production",
            createdAt: Date.now(),
          },
        },
      });

      const result = await deployPipeline({
        repo: "org/repo",
        branch: "main",
        provider: "vercel",
        project_id: "prj_test",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.overall_status).toBe("success");
      expect(parsed.steps).toHaveLength(1);
      expect(parsed.steps[0].name).toBe("trigger_deploy");
      expect(parsed.steps[0].status).toBe("success");
      expect(parsed.total_duration_ms).toBeGreaterThanOrEqual(0);
      expect(parsed.failure_reason).toBeUndefined();
    });
  });

  describe("successful pipeline — with test workflow and health check", () => {
    it("runs all steps and succeeds when everything passes", async () => {
      // Mock GitHub Actions dispatch (returns 204)
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/dispatches/,
        method: "POST",
        response: { status: 204, body: {} },
      });

      // Mock GitHub Actions polling — return a completed successful run
      // created_at must be >= triggerTime so use a far-future timestamp
      const futureTimeSuccess = new Date(Date.now() + 60000).toISOString();
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/runs/,
        response: {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 12345,
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/org/repo/actions/runs/12345",
                name: "CI",
                created_at: futureTimeSuccess,
                updated_at: futureTimeSuccess,
              },
            ],
          },
        },
      });

      // Mock Vercel trigger deploy
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_full_001",
            url: "my-app-full.vercel.app",
            state: "QUEUED",
            meta: { githubCommitRef: "main" },
            target: "production",
            createdAt: Date.now(),
          },
        },
      });

      // Mock health check — up
      mockFetch.addRoute({
        url: /https:\/\/my-app\.example\.com/,
        response: { status: 200, body: {} },
      });

      const result = await deployPipeline({
        repo: "org/repo",
        branch: "main",
        provider: "vercel",
        project_id: "prj_full_test",
        test_workflow: "ci.yml",
        health_url: "https://my-app.example.com",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.overall_status).toBe("success");
      expect(parsed.steps).toHaveLength(3);
      expect(parsed.steps[0].name).toBe("run_tests");
      expect(parsed.steps[0].status).toBe("success");
      expect(parsed.steps[1].name).toBe("trigger_deploy");
      expect(parsed.steps[1].status).toBe("success");
      expect(parsed.steps[2].name).toBe("health_check");
      expect(parsed.steps[2].status).toBe("success");
    });
  });

  describe("Fix 9 — aborts on health check failure", () => {
    it("returns failure immediately when health check returns down", async () => {
      // Mock Vercel trigger deploy — succeeds
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_health_fail",
            url: "my-app-down.vercel.app",
            state: "QUEUED",
            meta: { githubCommitRef: "main" },
            target: "production",
            createdAt: Date.now(),
          },
        },
      });

      // Mock health check — returns 503 (down)
      mockFetch.addRoute({
        url: /https:\/\/down\.example\.com/,
        response: { status: 503, ok: false, body: {} },
      });

      const result = await deployPipeline({
        repo: "org/repo",
        branch: "main",
        provider: "vercel",
        project_id: "prj_health_fail",
        health_url: "https://down.example.com",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.overall_status).toBe("failure");
      expect(parsed.failure_reason).toContain("Health check failed");
      // Must have exactly 2 steps: trigger_deploy + health_check
      expect(parsed.steps).toHaveLength(2);
      expect(parsed.steps[1].name).toBe("health_check");
      expect(parsed.steps[1].status).toBe("failure");
    });

    it("returns failure immediately when health check throws an error", async () => {
      // Mock Vercel trigger deploy — succeeds
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_health_err",
            url: "my-app-err.vercel.app",
            state: "QUEUED",
            meta: { githubCommitRef: "main" },
            target: "production",
            createdAt: Date.now(),
          },
        },
      });

      // Health check URL returns a 503, which HealthAdapter will report as "down"
      mockFetch.addRoute({
        url: /crash\.example\.com/,
        response: { status: 503, ok: false, body: {} },
      });

      const result = await deployPipeline({
        repo: "org/repo",
        branch: "main",
        provider: "vercel",
        project_id: "prj_health_err",
        health_url: "https://crash.example.com",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.overall_status).toBe("failure");
      // Fix 9: pipeline must abort on health check failure
      expect(["Health check failed", "Health check error"].some(
        (phrase) => parsed.failure_reason?.includes(phrase)
      )).toBe(true);
      // Must stop at health_check — no further steps
      const stepNames = parsed.steps.map((s: { name: string }) => s.name);
      expect(stepNames).not.toContain("error_check");
      expect(stepNames).toContain("health_check");
      expect(parsed.steps.find((s: { name: string }) => s.name === "health_check").status).toBe("failure");
    });
  });

  describe("aborts on test failure", () => {
    it("returns failure immediately when CI workflow fails", async () => {
      // Mock GitHub Actions dispatch
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/dispatches/,
        method: "POST",
        response: { status: 204, body: {} },
      });

      // Mock GitHub Actions polling — returns a failed run
      // created_at must be >= triggerTime (set before dispatch), so use a far-future timestamp
      const futureTime = new Date(Date.now() + 60000).toISOString();
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/runs/,
        response: {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 99999,
                status: "completed",
                conclusion: "failure",
                html_url: "https://github.com/org/repo/actions/runs/99999",
                name: "CI",
                created_at: futureTime,
                updated_at: futureTime,
              },
            ],
          },
        },
      });

      const result = await deployPipeline({
        repo: "org/repo",
        branch: "main",
        provider: "vercel",
        project_id: "prj_test_fail",
        test_workflow: "ci.yml",
        health_url: "https://my-app.example.com",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.overall_status).toBe("failure");
      expect(parsed.failure_reason).toContain("Tests failed");
      // Pipeline should have stopped after run_tests — no trigger_deploy step
      expect(parsed.steps).toHaveLength(1);
      expect(parsed.steps[0].name).toBe("run_tests");
      expect(parsed.steps[0].status).toBe("failure");
    });

    it("returns failure when CI workflow dispatch throws", async () => {
      // GitHub Actions dispatch — returns API error
      mockFetch.addRoute({
        url: /\/actions\/workflows\/bad-workflow\.yml\/dispatches/,
        method: "POST",
        response: {
          status: 404,
          ok: false,
          statusText: "Not Found",
          body: { message: "Not Found" },
        },
      });

      const result = await deployPipeline({
        repo: "org/repo",
        branch: "main",
        provider: "vercel",
        project_id: "prj_ci_err",
        test_workflow: "bad-workflow.yml",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.overall_status).toBe("failure");
      expect(parsed.failure_reason).toContain("Test step error");
      expect(parsed.steps).toHaveLength(1);
      expect(parsed.steps[0].name).toBe("run_tests");
      expect(parsed.steps[0].status).toBe("failure");
    });
  });
});
