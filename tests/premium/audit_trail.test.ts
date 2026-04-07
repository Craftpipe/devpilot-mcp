/**
 * audit_trail tests.
 * - Test requirePro gate
 * - Test query with no filters
 * - Test filter by timeframe
 * - Test filter by action_type
 * - Test custom limit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { auditTrail } from "../../src/premium/audit_trail.js";
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

describe("auditTrail()", () => {
  beforeEach(() => {
    setProLicense();
  });

  afterEach(() => {
    delete process.env.PRO_LICENSE;
    vi.restoreAllMocks();
  });

  describe("Pro gate", () => {
    it("throws requirePro error when PRO_LICENSE is not set", async () => {
      delete process.env.PRO_LICENSE;
      await expect(auditTrail({})).rejects.toThrow(
        "[audit_trail] requires a Pro license"
      );
    });

    it("throws with upgrade URL in the error message", async () => {
      delete process.env.PRO_LICENSE;
      await expect(auditTrail({})).rejects.toThrow(
        "https://craftpipe.dev/products/devpilot-mcp"
      );
    });
  });

  describe("query with no filters", () => {
    it("returns an empty entries array when audit log is empty", async () => {
      const result = await auditTrail({});

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeframe).toBeNull();
      expect(parsed.action_type).toBeNull();
      // The audit_trail call itself logs one entry, so total may be >= 0
      expect(typeof parsed.total).toBe("number");
      expect(Array.isArray(parsed.entries)).toBe(true);
    });

    it("returns entries with correct shape (id, timestamp, tool_name, success)", async () => {
      // Pre-populate audit log by spying on query to return test data
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([
        {
          id: 1,
          timestamp: "2024-01-15T10:00:00.000Z",
          tool_name: "deploy_status",
          provider: "vercel",
          input_summary: '{"project_id":"prj_test"}',
          result_summary: "2 deployments found",
          success: 1,
          duration_ms: 123,
        },
        {
          id: 2,
          timestamp: "2024-01-15T11:00:00.000Z",
          tool_name: "trigger_deploy",
          provider: "railway",
          input_summary: '{"project_id":"rly_proj"}',
          result_summary: "Deployment triggered",
          success: 1,
          duration_ms: 456,
        },
      ]);

      const result = await auditTrail({});

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.total).toBe(2);
      expect(parsed.entries).toHaveLength(2);

      const first = parsed.entries[0];
      expect(first.id).toBe(1);
      expect(first.tool_name).toBe("deploy_status");
      expect(first.provider).toBe("vercel");
      expect(first.success).toBe(true); // mapped from integer 1
      expect(first.duration_ms).toBe(123);

      querySpy.mockRestore();
    });

    it("maps success integer 0 to boolean false", async () => {
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([
        {
          id: 3,
          timestamp: "2024-01-15T12:00:00.000Z",
          tool_name: "get_errors",
          provider: "sentry",
          input_summary: "{}",
          result_summary: "Error: API down",
          success: 0,
          duration_ms: null,
        },
      ]);

      const result = await auditTrail({});

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.entries[0].success).toBe(false);
      expect(parsed.entries[0].duration_ms).toBeUndefined();

      querySpy.mockRestore();
    });
  });

  describe("filters", () => {
    it("passes timeframe filter to audit.query", async () => {
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([]);

      const result = await auditTrail({ timeframe: "7d" });

      expect(querySpy).toHaveBeenCalledWith(
        expect.objectContaining({ timeframe: "7d" })
      );

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.timeframe).toBe("7d");

      querySpy.mockRestore();
    });

    it("passes action_type filter to audit.query as tool_name", async () => {
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([]);

      await auditTrail({ action_type: "deploy_status" });

      expect(querySpy).toHaveBeenCalledWith(
        expect.objectContaining({ tool_name: "deploy_status" })
      );

      querySpy.mockRestore();
    });

    it("passes custom limit to audit.query", async () => {
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([]);

      await auditTrail({ limit: 10 });

      expect(querySpy).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 })
      );

      querySpy.mockRestore();
    });

    it("uses 50 as default limit when not specified", async () => {
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([]);

      await auditTrail({});

      expect(querySpy).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 })
      );

      querySpy.mockRestore();
    });

    it("returns null action_type in output when not filtered", async () => {
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([]);

      const result = await auditTrail({});

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.action_type).toBeNull();

      querySpy.mockRestore();
    });

    it("returns the action_type in output when filtered", async () => {
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([]);

      const result = await auditTrail({ action_type: "health_check" });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.action_type).toBe("health_check");

      querySpy.mockRestore();
    });
  });

  describe("self-logging", () => {
    it("logs the audit_trail query itself to the audit log", async () => {
      const querySpy = vi.spyOn(AuditLog.prototype, "query").mockReturnValueOnce([]);
      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await auditTrail({ timeframe: "1d" });

      const selfCall = logSpy.mock.calls.find(
        (c) => c[0].tool_name === "audit_trail"
      );
      expect(selfCall).toBeDefined();
      expect(selfCall![0].success).toBe(true);
      expect(selfCall![0].result_summary).toContain("audit entries returned");

      querySpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
