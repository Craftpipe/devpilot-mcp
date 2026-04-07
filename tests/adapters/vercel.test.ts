/**
 * VercelAdapter tests.
 * Covers all 6 methods: getDeployments, triggerDeploy, rollback, getLogs,
 * getEnvironmentVars, getCosts. Also verifies rate limit handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { VercelAdapter } from "../../src/adapters/vercel.js";

describe("VercelAdapter", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let adapter: VercelAdapter;

  beforeEach(() => {
    mockFetch = createMockFetch();
    process.env.VERCEL_TOKEN = "test-vercel-token";
    adapter = new VercelAdapter();
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.VERCEL_TOKEN;
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("throws when VERCEL_TOKEN is not set", () => {
      delete process.env.VERCEL_TOKEN;
      expect(() => new VercelAdapter()).toThrow("VERCEL_TOKEN");
    });

    it("creates adapter when token is set", () => {
      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("vercel");
    });
  });

  describe("getDeployments()", () => {
    it("returns mapped deployments array", async () => {
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: {
          body: {
            deployments: [
              {
                uid: "dpl_001",
                url: "app-001.vercel.app",
                state: "READY",
                meta: { githubCommitRef: "main" },
                target: "production",
                createdAt: 1700000000000,
                ready: 1700000060000,
              },
            ],
          },
        },
      });

      const deps = await adapter.getDeployments("prj_test");
      expect(deps).toHaveLength(1);
      expect(deps[0]!.id).toBe("dpl_001");
      expect(deps[0]!.url).toBe("https://app-001.vercel.app");
      expect(deps[0]!.state).toBe("ready");
      expect(deps[0]!.branch).toBe("main");
      expect(deps[0]!.environment).toBe("production");
      expect(deps[0]!.provider).toBe("vercel");
    });

    it("returns empty array when no deployments", async () => {
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: { body: { deployments: [] } },
      });

      const deps = await adapter.getDeployments("prj_empty");
      expect(deps).toHaveLength(0);
    });

    it("maps all deployment states correctly", async () => {
      const states = [
        { raw: "READY", expected: "ready" },
        { raw: "BUILDING", expected: "building" },
        { raw: "INITIALIZING", expected: "building" },
        { raw: "ERROR", expected: "error" },
        { raw: "CANCELED", expected: "canceled" },
        { raw: "QUEUED", expected: "queued" },
        { raw: "UNKNOWN", expected: "queued" },
      ];

      for (const { raw, expected } of states) {
        mockFetch.clearRoutes();
        mockFetch.addRoute({
          url: /\/v6\/deployments/,
          response: {
            body: {
              deployments: [{
                uid: "dpl_state",
                url: "state.vercel.app",
                state: raw,
                meta: {},
                target: "production",
                createdAt: Date.now(),
              }],
            },
          },
        });

        const deps = await adapter.getDeployments("prj_state");
        expect(deps[0]!.state).toBe(expected);
      }
    });

    it("throws on API error", async () => {
      mockFetch.addRoute({
        url: /\/v6\/deployments/,
        response: { status: 403, ok: false, statusText: "Forbidden", text: "access denied" },
      });

      await expect(adapter.getDeployments("prj_err")).rejects.toThrow(
        "Vercel API error (403)"
      );
    });
  });

  describe("triggerDeploy()", () => {
    it("POSTs to /v13/deployments and returns deployment", async () => {
      mockFetch.addRoute({
        url: /\/v13\/deployments/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_triggered",
            url: "triggered.vercel.app",
            state: "QUEUED",
            meta: { githubCommitRef: "feature/x" },
            target: "preview",
            createdAt: Date.now(),
          },
        },
      });

      const dep = await adapter.triggerDeploy("prj_test", {
        branch: "feature/x",
        environment: "preview",
      });

      expect(dep.id).toBe("dpl_triggered");
      expect(dep.state).toBe("queued");
      expect(dep.environment).toBe("preview");
    });
  });

  describe("rollback()", () => {
    it("POSTs to /v10/projects/{id}/promote/{depId}", async () => {
      mockFetch.addRoute({
        url: /\/v10\/projects\/prj_test\/promote\/dpl_target/,
        method: "POST",
        response: {
          body: {
            uid: "dpl_target",
            url: "rollback.vercel.app",
            state: "READY",
            meta: {},
            target: "production",
            createdAt: Date.now(),
          },
        },
      });

      const dep = await adapter.rollback("prj_test", "dpl_target");
      expect(dep.id).toBe("dpl_target");
      expect(dep.state).toBe("ready");
    });
  });

  describe("getLogs()", () => {
    it("returns mapped log entries", async () => {
      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_log\/events/,
        response: {
          body: [
            { created: 1700000000000, text: "Build started", level: "info", source: "build" },
            { created: 1700000005000, text: "npm install", level: "info", source: "build" },
            { created: 1700000060000, text: "Build complete", level: "info", source: "build" },
          ],
        },
      });

      const logs = await adapter.getLogs("dpl_log", 10);
      expect(logs).toHaveLength(3);
      expect(logs[0]!.message).toBe("Build started");
      expect(logs[0]!.level).toBe("info");
      expect(logs[0]!.source).toBe("build");
      expect(typeof logs[0]!.timestamp).toBe("string");
    });

    it("slices to requested line count", async () => {
      const events = Array.from({ length: 10 }, (_, i) => ({
        created: 1700000000000 + i * 1000,
        text: `Line ${i + 1}`,
        level: "info",
      }));

      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_slice\/events/,
        response: { body: events },
      });

      const logs = await adapter.getLogs("dpl_slice", 3);
      expect(logs).toHaveLength(3);
      expect(logs[0]!.message).toBe("Line 8");
      expect(logs[2]!.message).toBe("Line 10");
    });
  });

  describe("getEnvironmentVars()", () => {
    it("returns env vars with key and target", async () => {
      mockFetch.addRoute({
        url: /\/v9\/projects\/prj_env\/env/,
        response: {
          body: {
            envs: [
              { key: "DATABASE_URL", target: ["production"] },
              { key: "API_SECRET", target: ["production", "preview"] },
              { key: "NODE_ENV", target: [] },
            ],
          },
        },
      });

      const vars = await adapter.getEnvironmentVars("prj_env");
      expect(vars).toHaveLength(3);
      expect(vars[0]!.key).toBe("DATABASE_URL");
      expect(vars[0]!.target).toEqual(["production"]);
      expect(vars[1]!.target).toEqual(["production", "preview"]);
    });

    it("returns empty array when no env vars", async () => {
      mockFetch.addRoute({
        url: /\/v9\/projects\/prj_noenv\/env/,
        response: { body: { envs: [] } },
      });

      const vars = await adapter.getEnvironmentVars("prj_noenv");
      expect(vars).toHaveLength(0);
    });
  });

  describe("getCosts()", () => {
    it("returns cost report with defaults merged from API response", async () => {
      mockFetch.addRoute({
        url: /\/v1\/usage/,
        response: {
          body: {
            total_cost: 25.0,
            currency: "USD",
            breakdown: [{ service: "Edge Network", cost: 25.0 }],
            trend: "increasing",
            suggestions: [],
          },
        },
      });

      const report = await adapter.getCosts("30d");
      expect(report.total_cost).toBe(25.0);
      expect(report.currency).toBe("USD");
      expect(report.trend).toBe("increasing");
    });
  });

  describe("rate limit handling", () => {
    it("retries once on 429 and succeeds on second attempt", async () => {
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
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "Content-Type": "application/json" }),
          json: async () => ({ deployments: [] }),
          text: async () => "{}",
        } as unknown as Response;
      });

      const deps = await adapter.getDeployments("prj_rate");
      expect(deps).toHaveLength(0);
      expect(callCount).toBe(2);

      globalThis.fetch = originalFetch;
    });

    it("throws when second attempt also returns 429", async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "retry-after": "0" }),
        text: async () => "rate limited",
        json: async () => ({}),
      } as unknown as Response);

      await expect(adapter.getDeployments("prj_ratelimited")).rejects.toThrow(
        "Vercel rate limited"
      );

      globalThis.fetch = originalFetch;
    });
  });
});
