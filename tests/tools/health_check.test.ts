/**
 * health_check tool tests.
 * Verifies URL status checking, timeout handling, and audit logging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { healthCheck } from "../../src/tools/health_check.js";
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

describe("healthCheck()", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("successful responses", () => {
    it("returns up status for a 200 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/html" }),
      } as unknown as Response);

      const result = await healthCheck({
        urls: ["https://example.com"],
        timeout: 5000,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].url).toBe("https://example.com");
      expect(parsed.results[0].status).toBe("up");
      expect(parsed.results[0].status_code).toBe(200);
      expect(typeof parsed.results[0].response_time_ms).toBe("number");
      expect(parsed.summary.total).toBe(1);
      expect(parsed.summary.up).toBe(1);
      expect(parsed.summary.down).toBe(0);
    });

    it("returns down status for a non-200 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: new Headers(),
      } as unknown as Response);

      const result = await healthCheck({
        urls: ["https://broken.example.com"],
        timeout: 5000,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.results[0].status).toBe("down");
      expect(parsed.results[0].status_code).toBe(503);
      expect(parsed.results[0].error).toContain("503");
      expect(parsed.summary.down).toBe(1);
      expect(parsed.summary.up).toBe(0);
    });

    it("checks multiple URLs in parallel", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: new Headers(),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
        } as unknown as Response);

      const result = await healthCheck({
        urls: [
          "https://site1.example.com",
          "https://site2.example.com",
          "https://site3.example.com",
        ],
        timeout: 5000,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.results).toHaveLength(3);
      expect(parsed.summary.total).toBe(3);
      expect(parsed.summary.up).toBe(2);
      expect(parsed.summary.down).toBe(1);
    });

    it("includes checked_at timestamp in ISO format", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
      } as unknown as Response);

      const result = await healthCheck({ urls: ["https://example.com"] });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("uses default timeout of 5000ms when not specified", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
      } as unknown as Response);

      const result = await healthCheck({ urls: ["https://example.com"] });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeout_ms).toBe(5000);
    });
  });

  describe("timeout handling", () => {
    it("returns down status with timeout error on AbortError", async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(
        Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
      );

      const result = await healthCheck({
        urls: ["https://slow.example.com"],
        timeout: 100,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.results[0].status).toBe("down");
      expect(parsed.results[0].status_code).toBeNull();
      expect(parsed.results[0].error).toContain("Timeout");
      expect(parsed.results[0].error).toContain("100ms");
    });

    it("returns down status with error message on fetch failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(
        new Error("ECONNREFUSED connect ECONNREFUSED 127.0.0.1:80")
      );

      const result = await healthCheck({
        urls: ["https://unreachable.example.com"],
        timeout: 5000,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.results[0].status).toBe("down");
      expect(parsed.results[0].status_code).toBeNull();
      expect(parsed.results[0].error).toContain("ECONNREFUSED");
    });

    it("handles mixed up/timeout/down results correctly", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
        } as unknown as Response)
        .mockRejectedValueOnce(
          Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
        );

      const result = await healthCheck({
        urls: ["https://good.example.com", "https://slow.example.com"],
        timeout: 500,
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.summary.up).toBe(1);
      expect(parsed.summary.down).toBe(1);

      const downResult = parsed.results.find(
        (r: { url: string }) => r.url === "https://slow.example.com"
      );
      expect(downResult.error).toContain("Timeout");
    });
  });

  describe("audit logging", () => {
    it("creates an audit log entry on successful check", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
      } as unknown as Response);

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await healthCheck({
        urls: ["https://example.com"],
        timeout: 3000,
      });

      expect(logSpy).toHaveBeenCalledOnce();
      const logCall = logSpy.mock.calls[0]![0];
      expect(logCall.tool_name).toBe("health_check");
      expect(logCall.provider).toBe("http");
      expect(logCall.success).toBe(true);
      expect(logCall.result_summary).toContain("1/1 URLs up");

      logSpy.mockRestore();
    });
  });
});
