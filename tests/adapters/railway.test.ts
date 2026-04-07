/**
 * RailwayAdapter tests.
 * Covers all methods via GraphQL: getDeployments, triggerDeploy, rollback,
 * getLogs, getEnvironmentVars, getCosts. Verifies rate limit handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { RailwayAdapter } from "../../src/adapters/railway.js";

describe("RailwayAdapter", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let adapter: RailwayAdapter;

  beforeEach(() => {
    mockFetch = createMockFetch();
    process.env.RAILWAY_TOKEN = "test-railway-token";
    adapter = new RailwayAdapter();
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.RAILWAY_TOKEN;
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("throws when RAILWAY_TOKEN is not set", () => {
      delete process.env.RAILWAY_TOKEN;
      expect(() => new RailwayAdapter()).toThrow("RAILWAY_TOKEN");
    });

    it("creates adapter when token is set", () => {
      expect(adapter.name).toBe("railway");
    });
  });

  describe("getDeployments()", () => {
    it("returns mapped deployments from GraphQL", async () => {
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
                      id: "rly_dep_001",
                      status: "SUCCESS",
                      staticUrl: "https://svc.railway.app",
                      createdAt: "2024-01-15T10:00:00.000Z",
                      updatedAt: "2024-01-15T10:05:00.000Z",
                      meta: { branch: "main" },
                      environment: { name: "production" },
                    },
                  },
                  {
                    node: {
                      id: "rly_dep_002",
                      status: "DEPLOYING",
                      staticUrl: "",
                      createdAt: "2024-01-15T11:00:00.000Z",
                      updatedAt: "2024-01-15T11:01:00.000Z",
                      meta: { branch: "feature/x" },
                      environment: { name: "staging" },
                    },
                  },
                ],
              },
            },
          },
        },
      });

      const deps = await adapter.getDeployments("rly_proj");
      expect(deps).toHaveLength(2);

      expect(deps[0]!.id).toBe("rly_dep_001");
      expect(deps[0]!.state).toBe("ready");
      expect(deps[0]!.branch).toBe("main");
      expect(deps[0]!.environment).toBe("production");
      expect(deps[0]!.provider).toBe("railway");
      expect(deps[0]!.ready_at).toBe("2024-01-15T10:05:00.000Z");

      expect(deps[1]!.state).toBe("building");
      expect(deps[1]!.ready_at).toBeNull();
    });

    it("maps all Railway states correctly", async () => {
      const states = [
        { raw: "SUCCESS", expected: "ready" },
        { raw: "DEPLOYING", expected: "building" },
        { raw: "BUILDING", expected: "building" },
        { raw: "FAILED", expected: "error" },
        { raw: "CRASHED", expected: "error" },
        { raw: "REMOVED", expected: "canceled" },
        { raw: "WAITING", expected: "queued" },
      ];

      for (const { raw, expected } of states) {
        mockFetch.clearRoutes();
        mockFetch.addRoute({
          url: /railway\.app\/graphql/,
          method: "POST",
          response: {
            body: {
              data: {
                deployments: {
                  edges: [{
                    node: {
                      id: "rly_state",
                      status: raw,
                      staticUrl: "",
                      createdAt: "2024-01-15T10:00:00.000Z",
                      updatedAt: "2024-01-15T10:00:00.000Z",
                      meta: {},
                      environment: { name: "production" },
                    },
                  }],
                },
              },
            },
          },
        });

        const deps = await adapter.getDeployments("rly_proj");
        expect(deps[0]!.state).toBe(expected);
      }
    });

    it("throws on GraphQL errors array", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: { errors: [{ message: "Unauthorized" }] },
        },
      });

      await expect(adapter.getDeployments("rly_err")).rejects.toThrow(
        "Railway GraphQL error"
      );
    });

    it("throws when data is missing from response", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {},
        },
      });

      await expect(adapter.getDeployments("rly_nodata")).rejects.toThrow(
        "Railway GraphQL: no data in response"
      );
    });
  });

  describe("triggerDeploy()", () => {
    it("sends mutation and returns new deployment", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              deploymentCreate: {
                id: "rly_new",
                status: "DEPLOYING",
                staticUrl: "",
                createdAt: "2024-01-15T12:00:00.000Z",
                updatedAt: "2024-01-15T12:00:00.000Z",
                meta: { branch: "main" },
                environment: { name: "production" },
              },
            },
          },
        },
      });

      const dep = await adapter.triggerDeploy("rly_proj", { environment: "production" });
      expect(dep.id).toBe("rly_new");
      expect(dep.state).toBe("building");
    });
  });

  describe("rollback()", () => {
    it("sends rollback mutation and returns redeployed deployment", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              deploymentRedeploy: {
                id: "rly_rollback",
                status: "DEPLOYING",
                staticUrl: "",
                createdAt: "2024-01-15T10:00:00.000Z",
                updatedAt: "2024-01-15T10:00:00.000Z",
                meta: { branch: "main" },
                environment: { name: "production" },
              },
            },
          },
        },
      });

      const dep = await adapter.rollback("rly_proj", "rly_old_dep");
      expect(dep.id).toBe("rly_rollback");
      expect(dep.state).toBe("building");
    });
  });

  describe("getLogs()", () => {
    it("returns mapped log entries from GraphQL", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              deploymentLogs: [
                {
                  timestamp: "2024-01-15T10:00:00.000Z",
                  message: "Starting container",
                  severity: "INFO",
                },
                {
                  timestamp: "2024-01-15T10:00:05.000Z",
                  message: "Listening on :3000",
                  severity: "INFO",
                },
              ],
            },
          },
        },
      });

      const logs = await adapter.getLogs("rly_dep", 50);
      expect(logs).toHaveLength(2);
      expect(logs[0]!.timestamp).toBe("2024-01-15T10:00:00.000Z");
      expect(logs[0]!.message).toBe("Starting container");
      expect(logs[0]!.level).toBe("INFO");
    });

    it("returns empty array when no logs", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: { body: { data: { deploymentLogs: [] } } },
      });

      const logs = await adapter.getLogs("rly_dep_empty", 10);
      expect(logs).toHaveLength(0);
    });
  });

  describe("getEnvironmentVars()", () => {
    it("returns keys from variables object", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              variables: {
                DATABASE_URL: "postgres://...",
                API_KEY: "sk-...",
                NODE_ENV: "production",
              },
            },
          },
        },
      });

      const vars = await adapter.getEnvironmentVars("rly_proj");
      expect(vars).toHaveLength(3);
      const keys = vars.map((v) => v.key).sort();
      expect(keys).toEqual(["API_KEY", "DATABASE_URL", "NODE_ENV"]);
    });

    it("returns empty array when no variables", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: { body: { data: { variables: {} } } },
      });

      const vars = await adapter.getEnvironmentVars("rly_empty");
      expect(vars).toHaveLength(0);
    });
  });

  describe("getCosts()", () => {
    it("returns placeholder cost report (Railway has no public costs API)", async () => {
      const report = await adapter.getCosts("30d");
      expect(report.total_cost).toBe(0);
      expect(report.currency).toBe("USD");
      expect(report.trend).toBe("unavailable");
      expect(report.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe("rate limit handling", () => {
    it("retries once on 429 and succeeds", async () => {
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
          json: async () => ({
            data: {
              deployments: { edges: [] },
            },
          }),
          text: async () => "{}",
        } as unknown as Response;
      });

      const deps = await adapter.getDeployments("rly_rate");
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

      await expect(adapter.getDeployments("rly_ratelimited")).rejects.toThrow(
        "Railway rate limited"
      );

      globalThis.fetch = originalFetch;
    });
  });
});
