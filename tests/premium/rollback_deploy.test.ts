/**
 * rollback_deploy tests.
 * - Test requirePro gate
 * - Test explicit deployment_id rollback
 * - Test auto-select previous deploy when no deployment_id given
 * - Test error when no previous deploy exists
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { rollbackDeploy } from "../../src/premium/rollback_deploy.js";
import { AuditLog } from "../../src/lib/audit.js";

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

describe("rollbackDeploy()", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    setProLicense();
    process.env.VERCEL_TOKEN = "test-vercel-token";
    process.env.RAILWAY_TOKEN = "test-railway-token";
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.PRO_LICENSE;
    delete process.env.VERCEL_TOKEN;
    delete process.env.RAILWAY_TOKEN;
    vi.restoreAllMocks();
  });

  describe("Pro gate", () => {
    it("throws requirePro error when PRO_LICENSE is not set", async () => {
      delete process.env.PRO_LICENSE;
      await expect(
        rollbackDeploy({ provider: "vercel", project_id: "prj_test" })
      ).rejects.toThrow("[rollback_deploy] requires a Pro license");
    });

    it("throws with upgrade URL in the error message", async () => {
      delete process.env.PRO_LICENSE;
      await expect(
        rollbackDeploy({ provider: "vercel", project_id: "prj_test" })
      ).rejects.toThrow("https://craftpipe.dev/products/devpilot-mcp");
    });
  });

  describe("explicit deployment_id — provider: vercel", () => {
    it("rolls back to specified deployment ID", async () => {
      mockFetch.addRoute({
        url: /\/v10\/projects\/prj_test\/promote\/dpl_prev/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_prev",
            url: "my-app-prev.vercel.app",
            state: "READY",
            meta: { githubCommitRef: "main" },
            target: "production",
            createdAt: 1700000000000,
            ready: 1700000010000,
          },
        },
      });

      const result = await rollbackDeploy({
        provider: "vercel",
        project_id: "prj_test",
        deployment_id: "dpl_prev",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("vercel");
      expect(parsed.project_id).toBe("prj_test");
      expect(parsed.deployment.id).toBe("dpl_prev");
      expect(parsed.deployment.state).toBe("ready");
    });
  });

  describe("auto-select previous deploy when no deployment_id", () => {
    it("fetches deployments and rolls back to index 1 (previous)", async () => {
      // GET deployments — returns current + previous
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_current",
                url: "my-app-current.vercel.app",
                state: "READY",
                meta: { githubCommitRef: "main" },
                target: "production",
                createdAt: 1700000100000,
                ready: 1700000110000,
              },
              {
                uid: "dpl_previous",
                url: "my-app-prev.vercel.app",
                state: "READY",
                meta: { githubCommitRef: "main" },
                target: "production",
                createdAt: 1700000000000,
                ready: 1700000010000,
              },
            ],
          },
        },
      });

      // POST promote with previous ID
      mockFetch.addRoute({
        url: /\/v10\/projects\/prj_auto\/promote\/dpl_previous/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_previous",
            url: "my-app-prev.vercel.app",
            state: "READY",
            meta: { githubCommitRef: "main" },
            target: "production",
            createdAt: 1700000000000,
            ready: 1700000010000,
          },
        },
      });

      const result = await rollbackDeploy({
        provider: "vercel",
        project_id: "prj_auto",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.deployment.id).toBe("dpl_previous");
    });

    it("throws when only one deployment exists (no previous)", async () => {
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_only",
                url: "my-app.vercel.app",
                state: "READY",
                meta: {},
                target: "production",
                createdAt: 1700000000000,
              },
            ],
          },
        },
      });

      await expect(
        rollbackDeploy({ provider: "vercel", project_id: "prj_single" })
      ).rejects.toThrow("No previous deployment found");
    });

    it("throws when no deployments exist at all", async () => {
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: { body: { deployments: [] } },
      });

      await expect(
        rollbackDeploy({ provider: "vercel", project_id: "prj_empty" })
      ).rejects.toThrow("No previous deployment found");
    });
  });

  describe("provider: railway", () => {
    it("rolls back a Railway deployment via GraphQL mutation", async () => {
      // The rollback() method sends a deploymentRedeploy mutation
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              deploymentRedeploy: {
                id: "rly_rollback_new",
                status: "DEPLOYING",
                staticUrl: "https://my-service.railway.app",
                createdAt: "2024-01-15T10:20:00.000Z",
                updatedAt: "2024-01-15T10:20:00.000Z",
                meta: { branch: "main" },
                environment: { name: "production" },
              },
            },
          },
        },
      });

      const result = await rollbackDeploy({
        provider: "railway",
        project_id: "rly_proj",
        deployment_id: "rly_previous",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("railway");
      expect(parsed.deployment.provider).toBe("railway");
      expect(parsed.deployment.id).toBe("rly_rollback_new");
      expect(parsed.deployment.state).toBe("building");
    });
  });

  describe("audit logging", () => {
    it("creates an audit log entry on successful rollback", async () => {
      mockFetch.addRoute({
        url: /\/v10\/projects\/prj_log\/promote\/dpl_target/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_target",
            url: "target.vercel.app",
            state: "READY",
            meta: {},
            target: "production",
            createdAt: Date.now(),
          },
        },
      });

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await rollbackDeploy({
        provider: "vercel",
        project_id: "prj_log",
        deployment_id: "dpl_target",
      });

      const call = logSpy.mock.calls.find(
        (c) => c[0].tool_name === "rollback_deploy"
      );
      expect(call).toBeDefined();
      expect(call![0].success).toBe(true);
      expect(call![0].provider).toBe("vercel");
      expect(call![0].result_summary).toContain("dpl_target");

      logSpy.mockRestore();
    });
  });
});
