/**
 * deploy_status tool tests.
 * Verifies deployments are returned and audit log entry is created.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { deployStatus } from "../../src/tools/deploy_status.js";
import { AuditLog } from "../../src/lib/audit.js";

// We use an in-memory audit log in tests by patching the constructor
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

describe("deployStatus()", () => {
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
  });

  describe("provider: vercel", () => {
    it("returns deployments from Vercel", async () => {
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_abc123",
                url: "my-app-abc.vercel.app",
                state: "READY",
                meta: { githubCommitRef: "main" },
                target: "production",
                createdAt: 1700000000000,
                ready: 1700000010000,
              },
              {
                uid: "dpl_xyz789",
                url: "my-app-xyz.vercel.app",
                state: "BUILDING",
                meta: { githubCommitRef: "feature/new-ui" },
                target: "preview",
                createdAt: 1700000500000,
              },
            ],
          },
        },
      });

      const result = await deployStatus({
        provider: "vercel",
        project_id: "prj_test123",
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("vercel");
      expect(parsed.project_id).toBe("prj_test123");
      expect(parsed.deployments).toHaveLength(2);

      const first = parsed.deployments[0];
      expect(first.id).toBe("dpl_abc123");
      expect(first.state).toBe("ready");
      expect(first.url).toBe("https://my-app-abc.vercel.app");
      expect(first.branch).toBe("main");
      expect(first.environment).toBe("production");
      expect(first.provider).toBe("vercel");

      const second = parsed.deployments[1];
      expect(second.state).toBe("building");
    });

    it("returns empty deployments array when none exist", async () => {
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: { body: { deployments: [] } },
      });

      const result = await deployStatus({
        provider: "vercel",
        project_id: "prj_empty",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.deployments).toHaveLength(0);
    });

    it("creates an audit log entry on success", async () => {
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_audittest",
                url: "audit-test.vercel.app",
                state: "READY",
                createdAt: 1700000000000,
              },
            ],
          },
        },
      });

      // Capture log calls by spying on the prototype
      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await deployStatus({
        provider: "vercel",
        project_id: "prj_audit",
      });

      expect(logSpy).toHaveBeenCalledOnce();
      const logCall = logSpy.mock.calls[0]![0];
      expect(logCall.tool_name).toBe("deploy_status");
      expect(logCall.provider).toBe("vercel");
      expect(logCall.success).toBe(true);
      expect(logCall.result_summary).toContain("1 deployments found");

      logSpy.mockRestore();
    });
  });

  describe("provider: railway", () => {
    it("returns deployments from Railway via GraphQL", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              deployments: {
                edges: [
                  {
                    node: {
                      id: "rly_deploy_001",
                      status: "SUCCESS",
                      staticUrl: "https://my-service.railway.app",
                      createdAt: "2024-01-15T10:00:00.000Z",
                      updatedAt: "2024-01-15T10:05:00.000Z",
                      meta: { branch: "main" },
                      environment: { name: "production" },
                    },
                  },
                ],
              },
            },
          },
        },
      });

      const result = await deployStatus({
        provider: "railway",
        project_id: "rly_proj_123",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("railway");
      expect(parsed.deployments).toHaveLength(1);

      const dep = parsed.deployments[0];
      expect(dep.id).toBe("rly_deploy_001");
      expect(dep.state).toBe("ready");
      expect(dep.provider).toBe("railway");
    });
  });
});
