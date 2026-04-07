/**
 * trigger_deploy tool tests.
 * Verifies Vercel/Railway deploy trigger, response shape, and audit logging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { triggerDeploy } from "../../src/tools/trigger_deploy.js";
import { AuditLog } from "../../src/lib/audit.js";

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

describe("triggerDeploy()", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    process.env.VERCEL_TOKEN = "test-vercel-token";
    process.env.RAILWAY_TOKEN = "test-railway-token";
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.VERCEL_TOKEN;
    delete process.env.RAILWAY_TOKEN;
    vi.restoreAllMocks();
  });

  describe("provider: vercel", () => {
    it("triggers a Vercel deployment and returns deployment object", async () => {
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_new123",
            url: "my-app-new.vercel.app",
            state: "QUEUED",
            meta: { githubCommitRef: "main" },
            target: "production",
            createdAt: 1700000000000,
          },
        },
      });

      const result = await triggerDeploy({
        provider: "vercel",
        project_id: "prj_test",
        branch: "main",
        environment: "production",
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("vercel");
      expect(parsed.deployment.id).toBe("dpl_new123");
      expect(parsed.deployment.state).toBe("queued");
      expect(parsed.deployment.url).toBe("https://my-app-new.vercel.app");
      expect(parsed.deployment.branch).toBe("main");
      expect(parsed.deployment.environment).toBe("production");
      expect(parsed.deployment.provider).toBe("vercel");
    });

    it("uses default production environment when not specified", async () => {
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_default",
            url: "my-app-default.vercel.app",
            state: "QUEUED",
            meta: {},
            target: "production",
            createdAt: Date.now(),
          },
        },
      });

      const result = await triggerDeploy({
        provider: "vercel",
        project_id: "prj_default",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.deployment.environment).toBe("production");
    });

    it("triggers a preview deployment on a feature branch", async () => {
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_preview",
            url: "my-app-preview.vercel.app",
            state: "BUILDING",
            meta: { githubCommitRef: "feature/new-ui" },
            target: "preview",
            createdAt: Date.now(),
          },
        },
      });

      const result = await triggerDeploy({
        provider: "vercel",
        project_id: "prj_preview",
        branch: "feature/new-ui",
        environment: "preview",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.deployment.state).toBe("building");
      expect(parsed.deployment.branch).toBe("feature/new-ui");
      expect(parsed.deployment.environment).toBe("preview");
    });

    it("throws when VERCEL_TOKEN is not set", async () => {
      delete process.env.VERCEL_TOKEN;
      await expect(
        triggerDeploy({ provider: "vercel", project_id: "prj_test" })
      ).rejects.toThrow("VERCEL_TOKEN");
    });

    it("throws on Vercel API error (500)", async () => {
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          status: 500,
          ok: false,
          statusText: "Internal Server Error",
          text: "Vercel deployment service unavailable",
        },
      });

      await expect(
        triggerDeploy({ provider: "vercel", project_id: "prj_err" })
      ).rejects.toThrow("Vercel API error (500)");
    });

    it("logs a successful audit entry after triggering", async () => {
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_audit",
            url: "audit.vercel.app",
            state: "QUEUED",
            meta: {},
            target: "production",
            createdAt: Date.now(),
          },
        },
      });

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await triggerDeploy({ provider: "vercel", project_id: "prj_audit" });

      const call = logSpy.mock.calls.find(
        (c) => c[0].tool_name === "trigger_deploy"
      );
      expect(call).toBeDefined();
      expect(call![0].success).toBe(true);
      expect(call![0].provider).toBe("vercel");
      expect(call![0].result_summary).toContain("dpl_audit");

      logSpy.mockRestore();
    });
  });

  describe("provider: railway", () => {
    it("triggers a Railway deployment via GraphQL mutation", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              deploymentCreate: {
                id: "rly_new_001",
                status: "DEPLOYING",
                staticUrl: "https://new-service.railway.app",
                createdAt: "2024-01-15T10:00:00.000Z",
                updatedAt: "2024-01-15T10:00:00.000Z",
                meta: { branch: "main" },
                environment: { name: "production" },
              },
            },
          },
        },
      });

      const result = await triggerDeploy({
        provider: "railway",
        project_id: "rly_proj_123",
        branch: "main",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("railway");
      expect(parsed.deployment.id).toBe("rly_new_001");
      expect(parsed.deployment.state).toBe("building");
      expect(parsed.deployment.provider).toBe("railway");
    });

    it("throws when RAILWAY_TOKEN is not set", async () => {
      delete process.env.RAILWAY_TOKEN;
      await expect(
        triggerDeploy({ provider: "railway", project_id: "rly_test" })
      ).rejects.toThrow("RAILWAY_TOKEN");
    });

    it("throws on Railway GraphQL error response", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            errors: [{ message: "Project not found" }],
          },
        },
      });

      await expect(
        triggerDeploy({ provider: "railway", project_id: "rly_bad" })
      ).rejects.toThrow("Railway GraphQL error");
    });
  });

  describe("rate limit handling", () => {
    it("retries on Vercel 429 and succeeds", async () => {
      let callCount = 0;
      const originalFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            headers: new Headers({ "retry-after": "0" }),
            text: async () => "rate limited",
            json: async () => ({ error: "rate limited" }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "Content-Type": "application/json" }),
          json: async () => ({
            uid: "dpl_retry",
            url: "retry.vercel.app",
            state: "QUEUED",
            meta: {},
            target: "production",
            createdAt: Date.now(),
          }),
          text: async () => "{}",
        } as unknown as Response;
      });

      const result = await triggerDeploy({
        provider: "vercel",
        project_id: "prj_rate_limit",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.deployment.id).toBe("dpl_retry");
      expect(callCount).toBe(2);

      globalThis.fetch = originalFetch;
    });
  });
});
