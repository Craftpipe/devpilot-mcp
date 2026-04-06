/**
 * Audit trail tests — AuditLog class with in-memory SQLite.
 * Tests: log, cleanup, query, sanitize.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuditLog } from "../../src/lib/audit.js";

describe("AuditLog", () => {
  let audit: AuditLog;

  beforeEach(() => {
    // Use :memory: SQLite database for tests — no filesystem writes
    audit = new AuditLog(":memory:");
  });

  afterEach(() => {
    audit.close();
  });

  describe("log()", () => {
    it("logs a successful entry", () => {
      audit.log({
        tool_name: "deploy_status",
        provider: "vercel",
        input_summary: JSON.stringify({ project_id: "prj_123" }),
        result_summary: "2 deployments found",
        success: true,
        duration_ms: 123,
      });

      const rows = audit.query({ limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tool_name).toBe("deploy_status");
      expect(rows[0]!.provider).toBe("vercel");
      expect(rows[0]!.success).toBe(1);
      expect(rows[0]!.duration_ms).toBe(123);
    });

    it("logs a failed entry", () => {
      audit.log({
        tool_name: "trigger_deploy",
        provider: "railway",
        input_summary: JSON.stringify({ project_id: "prj_fail" }),
        result_summary: "Railway API down",
        success: false,
      });

      const rows = audit.query({ limit: 10 });
      expect(rows[0]!.success).toBe(0);
      expect(rows[0]!.result_summary).toBe("Railway API down");
    });

    it("truncates long result summaries at 500 chars", () => {
      const longResult = "x".repeat(600);
      audit.log({
        tool_name: "get_errors",
        provider: "sentry",
        input_summary: "{}",
        result_summary: longResult,
        success: true,
      });

      const rows = audit.query({ limit: 10 });
      expect(rows[0]!.result_summary.length).toBeLessThanOrEqual(500);
    });

    it("handles missing duration_ms gracefully", () => {
      audit.log({
        tool_name: "health_check",
        provider: "custom",
        input_summary: "{}",
        result_summary: "ok",
        success: true,
      });

      const rows = audit.query({ limit: 10 });
      expect(rows[0]!.duration_ms).toBeNull();
    });
  });

  describe("query()", () => {
    beforeEach(() => {
      // Insert multiple entries
      const tools = ["deploy_status", "trigger_deploy", "get_errors", "run_tests"];
      const providers = ["vercel", "railway", "sentry", "github-actions"];
      for (let i = 0; i < 4; i++) {
        audit.log({
          tool_name: tools[i]!,
          provider: providers[i]!,
          input_summary: "{}",
          result_summary: `result ${i}`,
          success: i % 2 === 0,
        });
      }
    });

    it("returns all entries up to limit", () => {
      const rows = audit.query({ limit: 10 });
      expect(rows).toHaveLength(4);
    });

    it("respects limit parameter", () => {
      const rows = audit.query({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it("filters by tool_name", () => {
      const rows = audit.query({ tool_name: "deploy_status", limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tool_name).toBe("deploy_status");
    });

    it("filters by provider", () => {
      const rows = audit.query({ provider: "sentry", limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.provider).toBe("sentry");
    });

    it("returns entries ordered by timestamp DESC", () => {
      const rows = audit.query({ limit: 10 });
      // All inserted at roughly the same time, but IDs should be descending
      // (most recent first due to ORDER BY timestamp DESC, then id)
      expect(rows[0]!.id).toBeGreaterThan(rows[rows.length - 1]!.id);
    });

    it("filters by timeframe 7d (all entries should qualify)", () => {
      const rows = audit.query({ timeframe: "7d", limit: 10 });
      expect(rows).toHaveLength(4);
    });
  });

  describe("sanitize()", () => {
    it("redacts token keys", () => {
      const result = audit.sanitize({ project_id: "prj_123", token: "secret-value" });
      const parsed = JSON.parse(result);
      expect(parsed.token).toBe("[REDACTED]");
      expect(parsed.project_id).toBe("prj_123");
    });

    it("redacts api_key keys", () => {
      const result = audit.sanitize({ api_key: "sk-1234" });
      const parsed = JSON.parse(result);
      expect(parsed.api_key).toBe("[REDACTED]");
    });

    it("redacts password keys", () => {
      const result = audit.sanitize({ password: "hunter2" });
      const parsed = JSON.parse(result);
      expect(parsed.password).toBe("[REDACTED]");
    });

    it("redacts secret keys", () => {
      const result = audit.sanitize({ client_secret: "very-secret" });
      const parsed = JSON.parse(result);
      expect(parsed.client_secret).toBe("[REDACTED]");
    });

    it("does NOT redact non-sensitive keys", () => {
      const result = audit.sanitize({ project_id: "prj_test", branch: "main" });
      const parsed = JSON.parse(result);
      expect(parsed.project_id).toBe("prj_test");
      expect(parsed.branch).toBe("main");
    });

    it("truncates long string values", () => {
      const result = audit.sanitize({ description: "x".repeat(300) });
      const parsed = JSON.parse(result);
      expect(parsed.description.length).toBeLessThanOrEqual(203); // 200 + "…"
    });
  });

  describe("90-day cleanup", () => {
    it("creates table successfully (cleanup runs on init)", () => {
      // The constructor runs cleanup — just verify we can query without error
      expect(() => audit.query({ limit: 1 })).not.toThrow();
    });
  });
});
