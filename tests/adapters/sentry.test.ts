/**
 * SentryAdapter tests.
 * Covers getErrors and getErrorDetails. Verifies error mapping, rate limit retry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { SentryAdapter } from "../../src/adapters/sentry.js";

describe("SentryAdapter", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let adapter: SentryAdapter;

  beforeEach(() => {
    mockFetch = createMockFetch();
    process.env.SENTRY_AUTH_TOKEN = "test-sentry-token";
    process.env.SENTRY_ORG = "test-org";
    adapter = new SentryAdapter();
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_ORG;
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("throws when SENTRY_AUTH_TOKEN is not set", () => {
      delete process.env.SENTRY_AUTH_TOKEN;
      expect(() => new SentryAdapter()).toThrow("SENTRY_AUTH_TOKEN");
    });

    it("throws when SENTRY_ORG is not set", () => {
      delete process.env.SENTRY_ORG;
      expect(() => new SentryAdapter()).toThrow("SENTRY_ORG");
    });

    it("creates adapter when both env vars are set", () => {
      expect(adapter.name).toBe("sentry");
    });
  });

  describe("getErrors()", () => {
    it("returns mapped error events", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "sen_001",
              title: "TypeError: Cannot read property 'foo' of undefined",
              culprit: "src/app.tsx",
              count: "156",
              firstSeen: "2024-01-15T08:00:00.000Z",
              lastSeen: "2024-01-15T12:00:00.000Z",
              level: "error",
              shortId: "APP-001",
            },
            {
              id: "sen_002",
              title: "Warning: React key prop missing",
              culprit: "src/list.tsx",
              count: "12",
              firstSeen: "2024-01-15T09:00:00.000Z",
              lastSeen: "2024-01-15T10:00:00.000Z",
              level: "warning",
              shortId: "APP-002",
            },
          ],
        },
      });

      const errors = await adapter.getErrors("my-app", "24h", 25);
      expect(errors).toHaveLength(2);

      expect(errors[0]!.id).toBe("sen_001");
      expect(errors[0]!.title).toBe("TypeError: Cannot read property 'foo' of undefined");
      expect(errors[0]!.culprit).toBe("src/app.tsx");
      expect(errors[0]!.count).toBe(156);
      expect(errors[0]!.first_seen).toBe("2024-01-15T08:00:00.000Z");
      expect(errors[0]!.last_seen).toBe("2024-01-15T12:00:00.000Z");
      expect(errors[0]!.level).toBe("error");
      expect(errors[0]!.short_id).toBe("APP-001");

      expect(errors[1]!.level).toBe("warning");
    });

    it("returns empty array when no issues", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { body: [] },
      });

      const errors = await adapter.getErrors("clean-app", "1h", 10);
      expect(errors).toHaveLength(0);
    });

    it("throws when project_slug is empty", async () => {
      await expect(adapter.getErrors("", "24h", 10)).rejects.toThrow(
        "project_slug is required"
      );
    });

    it("throws on 401 Unauthorized", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { status: 401, ok: false, statusText: "Unauthorized", text: "bad token" },
      });

      await expect(adapter.getErrors("my-app", "24h", 10)).rejects.toThrow(
        "Sentry API error (401)"
      );
    });

    it("throws on 404 — project not found", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: { status: 404, ok: false, statusText: "Not Found", text: "project missing" },
      });

      await expect(adapter.getErrors("missing-app", "24h", 10)).rejects.toThrow(
        "Sentry API error (404)"
      );
    });

    it("handles non-numeric count gracefully (returns 0)", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\//,
        response: {
          body: [
            {
              id: "sen_bad_count",
              title: "Bad count",
              culprit: "file.ts",
              count: "not_a_number",
              firstSeen: "2024-01-15T10:00:00.000Z",
              lastSeen: "2024-01-15T10:00:00.000Z",
              level: "error",
              shortId: "APP-BAD",
            },
          ],
        },
      });

      const errors = await adapter.getErrors("my-app", "24h", 10);
      expect(errors[0]!.count).toBe(0);
    });
  });

  describe("getErrorDetails()", () => {
    it("returns detailed error info including stack trace", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\/sen_detail\/$/,
        response: {
          body: {
            id: "sen_detail",
            title: "TypeError: undefined is not a function",
            culprit: "src/handler.ts",
            count: "23",
            firstSeen: "2024-01-15T10:00:00.000Z",
            lastSeen: "2024-01-15T11:00:00.000Z",
            level: "error",
            shortId: "APP-DET",
          },
        },
      });

      mockFetch.addRoute({
        url: /sentry\.io.*\/events\/latest\//,
        response: {
          body: {
            id: "evt_001",
            title: "TypeError: undefined is not a function",
            culprit: "src/handler.ts",
            entries: [
              {
                type: "exception",
                data: {
                  values: [
                    {
                      stacktrace: {
                        frames: [
                          { filename: "src/handler.ts", function: "handleRequest", lineNo: 42 },
                          { filename: "src/index.ts", function: "main", lineNo: 10 },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
            tags: [
              { key: "environment", value: "production" },
              { key: "release", value: "v1.2.3" },
            ],
            contexts: {
              browser: { name: "Chrome", version: "120" },
            },
          },
        },
      });

      const detail = await adapter.getErrorDetails("sen_detail");
      expect(detail.id).toBe("sen_detail");
      expect(detail.count).toBe(23);
      expect(detail.stack_trace).toContain("handleRequest");
      expect(detail.stack_trace).toContain("src/handler.ts");
      expect(detail.stack_trace).toContain("42");
      expect(detail.tags["environment"]).toBe("production");
      expect(detail.tags["release"]).toBe("v1.2.3");
    });

    it("returns empty stack trace when no exception entry", async () => {
      mockFetch.addRoute({
        url: /sentry\.io.*\/issues\/sen_no_stack\/$/,
        response: {
          body: {
            id: "sen_no_stack",
            title: "Some error",
            culprit: "file.ts",
            count: "1",
            firstSeen: "2024-01-15T10:00:00.000Z",
            lastSeen: "2024-01-15T10:00:00.000Z",
            level: "info",
            shortId: "APP-NS",
          },
        },
      });

      mockFetch.addRoute({
        url: /sentry\.io.*\/events\/latest\//,
        response: {
          body: {
            id: "evt_002",
            entries: [],
            tags: [],
            contexts: {},
          },
        },
      });

      const detail = await adapter.getErrorDetails("sen_no_stack");
      expect(detail.stack_trace).toBe("");
    });
  });

  describe("rate limit handling", () => {
    it("retries on 429 and succeeds", async () => {
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
          json: async () => [],
          text: async () => "[]",
        } as unknown as Response;
      });

      const errors = await adapter.getErrors("my-app", "24h", 10);
      expect(errors).toHaveLength(0);
      expect(callCount).toBe(2);

      globalThis.fetch = originalFetch;
    });

    it("throws when both attempts return 429", async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "retry-after": "0" }),
        text: async () => "rate limited",
        json: async () => ({}),
      } as unknown as Response);

      await expect(adapter.getErrors("my-app", "24h", 10)).rejects.toThrow(
        "Sentry rate limited"
      );

      globalThis.fetch = originalFetch;
    });
  });
});
