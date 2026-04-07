/**
 * get_errors tool tests.
 * Verifies project_slug required, timeframe handling, Sentry error mapping.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { getErrors } from "../../src/tools/get_errors.js";
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

describe("getErrors()", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    process.env.SENTRY_AUTH_TOKEN = "test-sentry-token";
    process.env.SENTRY_ORG = "test-org";
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_ORG;
    vi.restoreAllMocks();
  });

  describe("validation", () => {
    it("throws when project_slug is empty", async () => {
      await expect(
        getErrors({ provider: "sentry", project_slug: "" })
      ).rejects.toThrow("project_slug is required");
    });

    it("throws when SENTRY_AUTH_TOKEN is not set", async () => {
      delete process.env.SENTRY_AUTH_TOKEN;
      await expect(
        getErrors({ provider: "sentry", project_slug: "my-app" })
      ).rejects.toThrow("SENTRY_AUTH_TOKEN");
    });

    it("throws when SENTRY_ORG is not set", async () => {
      delete process.env.SENTRY_ORG;
      await expect(
        getErrors({ provider: "sentry", project_slug: "my-app" })
      ).rejects.toThrow("SENTRY_ORG");
    });
  });

  describe("happy path", () => {
    it("returns errors from Sentry with correct mapping", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "issue_001",
              title: "TypeError: Cannot read properties of undefined",
              culprit: "src/components/Button.tsx",
              count: "42",
              firstSeen: "2024-01-15T10:00:00.000Z",
              lastSeen: "2024-01-15T11:00:00.000Z",
              level: "error",
              shortId: "MY-APP-001",
            },
            {
              id: "issue_002",
              title: "UnhandledPromiseRejection: Network error",
              culprit: "src/api/client.ts",
              count: "7",
              firstSeen: "2024-01-15T09:00:00.000Z",
              lastSeen: "2024-01-15T10:30:00.000Z",
              level: "warning",
              shortId: "MY-APP-002",
            },
          ],
        },
      });

      const result = await getErrors({
        provider: "sentry",
        project_slug: "my-app",
        timeframe: "24h",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("sentry");
      expect(parsed.project_slug).toBe("my-app");
      expect(parsed.timeframe).toBe("24h");
      expect(parsed.errors).toHaveLength(2);

      const first = parsed.errors[0];
      expect(first.id).toBe("issue_001");
      expect(first.title).toBe("TypeError: Cannot read properties of undefined");
      expect(first.culprit).toBe("src/components/Button.tsx");
      expect(first.count).toBe(42);
      expect(first.first_seen).toBe("2024-01-15T10:00:00.000Z");
      expect(first.last_seen).toBe("2024-01-15T11:00:00.000Z");
      expect(first.level).toBe("error");
      expect(first.short_id).toBe("MY-APP-001");
    });

    it("returns empty array when no errors exist", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { body: [] },
      });

      const result = await getErrors({
        provider: "sentry",
        project_slug: "clean-app",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.errors).toHaveLength(0);
    });

    it("uses 24h as default timeframe when not specified", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { body: [] },
      });

      const result = await getErrors({
        provider: "sentry",
        project_slug: "my-app",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeframe).toBe("24h");
    });

    it("uses specified 1h timeframe", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { body: [] },
      });

      const result = await getErrors({
        provider: "sentry",
        project_slug: "my-app",
        timeframe: "1h",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeframe).toBe("1h");
    });

    it("uses specified 7d timeframe", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { body: [] },
      });

      const result = await getErrors({
        provider: "sentry",
        project_slug: "my-app",
        timeframe: "7d",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeframe).toBe("7d");
    });

    it("converts count string to integer", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "issue_count",
              title: "Some error",
              culprit: "file.ts",
              count: "999",
              firstSeen: "2024-01-15T10:00:00.000Z",
              lastSeen: "2024-01-15T10:00:00.000Z",
              level: "error",
              shortId: "APP-999",
            },
          ],
        },
      });

      const result = await getErrors({
        provider: "sentry",
        project_slug: "my-app",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(typeof parsed.errors[0].count).toBe("number");
      expect(parsed.errors[0].count).toBe(999);
    });
  });

  describe("error handling", () => {
    it("throws on Sentry API error (401)", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          status: 401,
          ok: false,
          statusText: "Unauthorized",
          text: "Invalid token",
        },
      });

      await expect(
        getErrors({ provider: "sentry", project_slug: "my-app" })
      ).rejects.toThrow("Sentry API error (401)");
    });

    it("throws on Sentry API error (404 — project not found)", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          status: 404,
          ok: false,
          statusText: "Not Found",
          text: "Project not found",
        },
      });

      await expect(
        getErrors({ provider: "sentry", project_slug: "missing-app" })
      ).rejects.toThrow("Sentry API error (404)");
    });
  });

  describe("audit logging", () => {
    it("creates an audit log entry on success", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { body: [] },
      });

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await getErrors({ provider: "sentry", project_slug: "my-app" });

      const call = logSpy.mock.calls.find(
        (c) => c[0].tool_name === "get_errors"
      );
      expect(call).toBeDefined();
      expect(call![0].success).toBe(true);
      expect(call![0].provider).toBe("sentry");
      expect(call![0].result_summary).toContain("errors found");

      logSpy.mockRestore();
    });
  });

  describe("rate limit handling", () => {
    it("retries on Sentry 429 and succeeds", async () => {
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
          json: async () => [],
          text: async () => "[]",
        } as unknown as Response;
      });

      const result = await getErrors({
        provider: "sentry",
        project_slug: "my-app",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.errors).toHaveLength(0);
      expect(callCount).toBe(2);

      globalThis.fetch = originalFetch;
    });
  });
});
