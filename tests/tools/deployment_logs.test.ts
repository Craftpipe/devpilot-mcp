/**
 * deployment_logs tool tests.
 * Verifies log fetch from Vercel/Railway, empty deployment_id error, defaults.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { deploymentLogs } from "../../src/tools/deployment_logs.js";
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

describe("deploymentLogs()", () => {
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

  describe("validation", () => {
    it("throws when deployment_id is missing (empty string)", async () => {
      await expect(
        deploymentLogs({ provider: "vercel", deployment_id: "" })
      ).rejects.toThrow("deployment_id is required");
    });

    it("throws when deployment_id is not provided at all", async () => {
      await expect(
        deploymentLogs({ provider: "vercel" })
      ).rejects.toThrow("deployment_id is required");
    });

    it("throws when VERCEL_TOKEN is not set", async () => {
      delete process.env.VERCEL_TOKEN;
      await expect(
        deploymentLogs({ provider: "vercel", deployment_id: "dpl_test" })
      ).rejects.toThrow("VERCEL_TOKEN");
    });
  });

  describe("provider: vercel", () => {
    it("returns log entries from Vercel events endpoint", async () => {
      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_test\/events/,
        response: {
          body: [
            {
              created: 1700000000000,
              text: "Build started",
              level: "info",
              source: "build",
            },
            {
              created: 1700000010000,
              text: "Installing dependencies",
              level: "info",
              source: "build",
            },
            {
              created: 1700000060000,
              text: "Build completed successfully",
              level: "info",
              source: "build",
            },
          ],
        },
      });

      const result = await deploymentLogs({
        provider: "vercel",
        deployment_id: "dpl_test",
        lines: 100,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("vercel");
      expect(parsed.deployment_id).toBe("dpl_test");
      expect(parsed.lines_requested).toBe(100);
      expect(parsed.logs).toHaveLength(3);
      expect(parsed.logs[0].message).toBe("Build started");
      expect(parsed.logs[0].level).toBe("info");
      expect(typeof parsed.logs[0].timestamp).toBe("string");
    });

    it("uses 100 as default lines when not specified", async () => {
      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_default\/events/,
        response: { body: [] },
      });

      const result = await deploymentLogs({
        provider: "vercel",
        deployment_id: "dpl_default",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.lines_requested).toBe(100);
    });

    it("respects lines limit by slicing last N entries", async () => {
      // Return 5 log entries but request only 2
      const events = Array.from({ length: 5 }, (_, i) => ({
        created: 1700000000000 + i * 1000,
        text: `Log line ${i + 1}`,
        level: "info",
        source: "build",
      }));

      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_lines\/events/,
        response: { body: events },
      });

      const result = await deploymentLogs({
        provider: "vercel",
        deployment_id: "dpl_lines",
        lines: 2,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.logs).toHaveLength(2);
      // Should be LAST 2 entries
      expect(parsed.logs[0].message).toBe("Log line 4");
      expect(parsed.logs[1].message).toBe("Log line 5");
    });

    it("returns empty logs array when no events exist", async () => {
      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_empty\/events/,
        response: { body: [] },
      });

      const result = await deploymentLogs({
        provider: "vercel",
        deployment_id: "dpl_empty",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.logs).toHaveLength(0);
    });

    it("filters out log entries without text", async () => {
      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_notext\/events/,
        response: {
          body: [
            { created: 1700000000000, text: "Valid log", level: "info" },
            { created: 1700000010000, level: "debug" }, // no text — should be filtered
            { created: 1700000020000, text: "", level: "info" }, // empty text — should be filtered
          ],
        },
      });

      const result = await deploymentLogs({
        provider: "vercel",
        deployment_id: "dpl_notext",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.logs).toHaveLength(1);
      expect(parsed.logs[0].message).toBe("Valid log");
    });
  });

  describe("provider: railway", () => {
    it("returns log entries from Railway via GraphQL", async () => {
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              deploymentLogs: [
                {
                  timestamp: "2024-01-15T10:00:00.000Z",
                  message: "Starting service",
                  severity: "INFO",
                },
                {
                  timestamp: "2024-01-15T10:00:05.000Z",
                  message: "Service listening on port 3000",
                  severity: "INFO",
                },
              ],
            },
          },
        },
      });

      const result = await deploymentLogs({
        provider: "railway",
        deployment_id: "rly_dep_001",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("railway");
      expect(parsed.deployment_id).toBe("rly_dep_001");
      expect(parsed.logs).toHaveLength(2);
      expect(parsed.logs[0].message).toBe("Starting service");
      expect(parsed.logs[0].level).toBe("INFO");
    });
  });

  describe("audit logging", () => {
    it("creates an audit log entry on success", async () => {
      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_audit\/events/,
        response: {
          body: [
            { created: Date.now(), text: "Build ok", level: "info" },
          ],
        },
      });

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await deploymentLogs({
        provider: "vercel",
        deployment_id: "dpl_audit",
      });

      const call = logSpy.mock.calls.find(
        (c) => c[0].tool_name === "deployment_logs"
      );
      expect(call).toBeDefined();
      expect(call![0].success).toBe(true);
      expect(call![0].result_summary).toContain("1 log entries fetched");

      logSpy.mockRestore();
    });
  });

  describe("error handling", () => {
    it("throws on Vercel API error (404)", async () => {
      mockFetch.addRoute({
        url: /\/v3\/deployments\/dpl_missing\/events/,
        response: {
          status: 404,
          ok: false,
          statusText: "Not Found",
          text: "Deployment not found",
        },
      });

      await expect(
        deploymentLogs({
          provider: "vercel",
          deployment_id: "dpl_missing",
        })
      ).rejects.toThrow("Vercel API error (404)");
    });
  });
});
