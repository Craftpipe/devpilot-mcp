/**
 * cost_monitor tests.
 * - Test requirePro gate
 * - Test cost report from Vercel
 * - Test Railway placeholder response
 * - Test timeframe defaults and options
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { costMonitor } from "../../src/premium/cost_monitor.js";
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

function setProLicense() {
  process.env.PRO_LICENSE = "CPK-test-license-key";
}

describe("costMonitor()", () => {
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
        costMonitor({ provider: "vercel" })
      ).rejects.toThrow("[cost_monitor] requires a Pro license");
    });

    it("throws with upgrade URL in the error message", async () => {
      delete process.env.PRO_LICENSE;
      await expect(
        costMonitor({ provider: "vercel" })
      ).rejects.toThrow("https://craftpipe.dev/products/devpilot-mcp");
    });

    it("throws with PRO_LICENSE instruction in message", async () => {
      delete process.env.PRO_LICENSE;
      await expect(
        costMonitor({ provider: "vercel" })
      ).rejects.toThrow("PRO_LICENSE");
    });
  });

  describe("provider: vercel", () => {
    it("returns cost report from Vercel usage API", async () => {
      mockFetch.addRoute({
        url: /\/v1\/usage/,
        response: {
          body: {
            total_cost: 42.50,
            currency: "USD",
            breakdown: [
              { service: "Bandwidth", cost: 10.00 },
              { service: "Compute", cost: 32.50 },
            ],
            trend: "increasing",
            suggestions: ["Consider enabling edge caching"],
          },
        },
      });

      const result = await costMonitor({
        provider: "vercel",
        timeframe: "30d",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("vercel");
      expect(parsed.timeframe).toBe("30d");
      expect(parsed.report.total_cost).toBe(42.50);
      expect(parsed.report.currency).toBe("USD");
      expect(parsed.report.trend).toBe("increasing");
    });

    it("defaults to 30d timeframe when not specified", async () => {
      mockFetch.addRoute({
        url: /\/v1\/usage/,
        response: {
          body: {
            total_cost: 0,
            currency: "USD",
            breakdown: [],
            trend: "stable",
            suggestions: [],
          },
        },
      });

      const result = await costMonitor({ provider: "vercel" });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeframe).toBe("30d");
    });

    it("accepts 7d timeframe", async () => {
      mockFetch.addRoute({
        url: /\/v1\/usage/,
        response: {
          body: {
            total_cost: 5.00,
            currency: "USD",
            breakdown: [],
            trend: "stable",
            suggestions: [],
          },
        },
      });

      const result = await costMonitor({
        provider: "vercel",
        timeframe: "7d",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeframe).toBe("7d");
    });

    it("accepts 90d timeframe", async () => {
      mockFetch.addRoute({
        url: /\/v1\/usage/,
        response: {
          body: {
            total_cost: 150.00,
            currency: "USD",
            breakdown: [],
            trend: "stable",
            suggestions: [],
          },
        },
      });

      const result = await costMonitor({
        provider: "vercel",
        timeframe: "90d",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeframe).toBe("90d");
    });

    it("throws when VERCEL_TOKEN is not set", async () => {
      delete process.env.VERCEL_TOKEN;
      await expect(
        costMonitor({ provider: "vercel" })
      ).rejects.toThrow("VERCEL_TOKEN");
    });
  });

  describe("provider: railway", () => {
    it("returns Railway placeholder cost report (no public API)", async () => {
      const result = await costMonitor({ provider: "railway" });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("railway");
      expect(parsed.report.total_cost).toBe(0);
      expect(parsed.report.currency).toBe("USD");
      expect(parsed.report.trend).toBe("unavailable");
      expect(parsed.report.suggestions).toHaveLength(1);
      expect(parsed.report.suggestions[0]).toContain("railway.app");
    });

    it("does not make HTTP calls for Railway (placeholder)", async () => {
      const fetchSpy = vi.fn();
      const originalFetch = globalThis.fetch;
      // Track if fetch was called for Railway specifically
      globalThis.fetch = vi.fn().mockImplementation((...args: unknown[]) => {
        const url = String(args[0]);
        if (url.includes("railway")) {
          fetchSpy();
        }
        return originalFetch(...(args as Parameters<typeof fetch>));
      });

      await costMonitor({ provider: "railway" });

      // Railway cost endpoint doesn't exist — no GraphQL calls expected
      expect(fetchSpy).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
    });
  });

  describe("audit logging", () => {
    it("creates an audit log entry on success", async () => {
      mockFetch.addRoute({
        url: /\/v1\/usage/,
        response: {
          body: {
            total_cost: 10,
            currency: "USD",
            breakdown: [],
            trend: "stable",
            suggestions: [],
          },
        },
      });

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await costMonitor({ provider: "vercel" });

      const call = logSpy.mock.calls.find(
        (c) => c[0].tool_name === "cost_monitor"
      );
      expect(call).toBeDefined();
      expect(call![0].success).toBe(true);
      expect(call![0].provider).toBe("vercel");
      expect(call![0].result_summary).toContain("USD");

      logSpy.mockRestore();
    });
  });
});
