/**
 * environment_sync tests.
 * - Test requirePro gate
 * - Test diff output with keys present_in_all, only_in_first, only_in_second, missing_in_some
 * - Test at-least-two-environments validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { environmentSync } from "../../src/premium/environment_sync.js";
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

describe("environmentSync()", () => {
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
        environmentSync({ provider: "vercel", environments: ["production", "staging"] })
      ).rejects.toThrow("[environment_sync] requires a Pro license");
    });
  });

  describe("validation", () => {
    it("throws when fewer than two environments provided", async () => {
      await expect(
        environmentSync({ provider: "vercel", environments: ["production"] })
      ).rejects.toThrow("At least two environments");
    });

    it("throws when environments array is empty", async () => {
      await expect(
        environmentSync({ provider: "vercel", environments: [] })
      ).rejects.toThrow("At least two environments");
    });
  });

  describe("diff output — provider: vercel", () => {
    it("marks keys present in all environments", async () => {
      // production env vars
      mockFetch.addRoute({
        url: /\/v9\/projects\/production\/env/,
        response: {
          body: {
            envs: [
              { key: "DATABASE_URL", target: ["production"] },
              { key: "API_KEY", target: ["production"] },
              { key: "NODE_ENV", target: ["production"] },
            ],
          },
        },
      });

      // staging env vars
      mockFetch.addRoute({
        url: /\/v9\/projects\/staging\/env/,
        response: {
          body: {
            envs: [
              { key: "DATABASE_URL", target: ["staging"] },
              { key: "API_KEY", target: ["staging"] },
              { key: "NODE_ENV", target: ["staging"] },
            ],
          },
        },
      });

      const result = await environmentSync({
        provider: "vercel",
        environments: ["production", "staging"],
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.environments).toEqual(["production", "staging"]);
      expect(parsed.total_keys).toBe(3);
      expect(parsed.summary.in_all).toBe(3);
      expect(parsed.summary.missing_in_some).toBe(0);
      expect(parsed.summary.only_in_one).toBe(0);

      const allInAll = parsed.diff.every(
        (d: { status: string }) => d.status === "present_in_all"
      );
      expect(allInAll).toBe(true);
    });

    it("detects keys only in first environment", async () => {
      mockFetch.addRoute({
        url: /\/v9\/projects\/production\/env/,
        response: {
          body: {
            envs: [
              { key: "PROD_ONLY_KEY", target: ["production"] },
              { key: "SHARED_KEY", target: ["production"] },
            ],
          },
        },
      });

      mockFetch.addRoute({
        url: /\/v9\/projects\/staging\/env/,
        response: {
          body: {
            envs: [
              { key: "SHARED_KEY", target: ["staging"] },
            ],
          },
        },
      });

      const result = await environmentSync({
        provider: "vercel",
        environments: ["production", "staging"],
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.total_keys).toBe(2);
      expect(parsed.summary.in_all).toBe(1);
      expect(parsed.summary.only_in_one).toBe(1);

      const prodOnly = parsed.diff.find(
        (d: { key: string }) => d.key === "PROD_ONLY_KEY"
      );
      expect(prodOnly.status).toBe("only_in_first");
      expect(prodOnly.environments.production).toBe("present");
      expect(prodOnly.environments.staging).toBe("missing");
    });

    it("detects keys only in second environment", async () => {
      mockFetch.addRoute({
        url: /\/v9\/projects\/production\/env/,
        response: {
          body: {
            envs: [{ key: "SHARED_KEY", target: ["production"] }],
          },
        },
      });

      mockFetch.addRoute({
        url: /\/v9\/projects\/staging\/env/,
        response: {
          body: {
            envs: [
              { key: "SHARED_KEY", target: ["staging"] },
              { key: "STAGING_ONLY", target: ["staging"] },
            ],
          },
        },
      });

      const result = await environmentSync({
        provider: "vercel",
        environments: ["production", "staging"],
      });

      const parsed = JSON.parse(result.content[0]!.text);
      const stagingOnly = parsed.diff.find(
        (d: { key: string }) => d.key === "STAGING_ONLY"
      );
      expect(stagingOnly.status).toBe("only_in_second");
      expect(stagingOnly.environments.production).toBe("missing");
      expect(stagingOnly.environments.staging).toBe("present");
    });

    it("diff is sorted alphabetically by key", async () => {
      mockFetch.addRoute({
        url: /\/v9\/projects\/production\/env/,
        response: {
          body: {
            envs: [
              { key: "ZEBRA_KEY" },
              { key: "ALPHA_KEY" },
              { key: "MIDDLE_KEY" },
            ],
          },
        },
      });

      mockFetch.addRoute({
        url: /\/v9\/projects\/staging\/env/,
        response: {
          body: {
            envs: [
              { key: "ZEBRA_KEY" },
              { key: "ALPHA_KEY" },
              { key: "MIDDLE_KEY" },
            ],
          },
        },
      });

      const result = await environmentSync({
        provider: "vercel",
        environments: ["production", "staging"],
      });

      const parsed = JSON.parse(result.content[0]!.text);
      const keys = parsed.diff.map((d: { key: string }) => d.key);
      expect(keys).toEqual(["ALPHA_KEY", "MIDDLE_KEY", "ZEBRA_KEY"]);
    });

    it("returns empty diff when both environments have no keys", async () => {
      mockFetch.addRoute({
        url: /\/v9\/projects\/production\/env/,
        response: { body: { envs: [] } },
      });

      mockFetch.addRoute({
        url: /\/v9\/projects\/staging\/env/,
        response: { body: { envs: [] } },
      });

      const result = await environmentSync({
        provider: "vercel",
        environments: ["production", "staging"],
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.total_keys).toBe(0);
      expect(parsed.diff).toHaveLength(0);
    });
  });

  describe("provider: railway", () => {
    it("compares env vars across Railway environments", async () => {
      // First env call
      mockFetch.addRoute({
        url: /railway\.app\/graphql/,
        method: "POST",
        response: {
          body: {
            data: {
              variables: {
                DATABASE_URL: "***",
                API_SECRET: "***",
              },
            },
          },
        },
      });

      const result = await environmentSync({
        provider: "railway",
        environments: ["production", "staging"],
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("railway");
      expect(parsed.environments).toEqual(["production", "staging"]);
    });
  });

  describe("audit logging", () => {
    it("creates an audit log entry on success", async () => {
      mockFetch.addRoute({
        url: /\/v9\/projects\/production\/env/,
        response: { body: { envs: [] } },
      });

      mockFetch.addRoute({
        url: /\/v9\/projects\/staging\/env/,
        response: { body: { envs: [] } },
      });

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await environmentSync({
        provider: "vercel",
        environments: ["production", "staging"],
      });

      const call = logSpy.mock.calls.find(
        (c) => c[0].tool_name === "environment_sync"
      );
      expect(call).toBeDefined();
      expect(call![0].success).toBe(true);
      expect(call![0].provider).toBe("vercel");

      logSpy.mockRestore();
    });
  });
});
