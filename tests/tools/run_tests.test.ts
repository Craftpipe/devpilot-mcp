/**
 * run_tests tool tests.
 * Verifies GitHub Actions workflow trigger, polling for new run, and defaults.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { runTests } from "../../src/tools/run_tests.js";
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

describe("runTests()", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    process.env.GITHUB_TOKEN = "test-github-token";
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
  });

  describe("happy path", () => {
    it("triggers a workflow and returns the new run after polling", async () => {
      // Mock 204 dispatch
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/dispatches/,
        method: "POST",
        response: { status: 204, body: {} },
      });

      const futureTs = new Date(Date.now() + 60000).toISOString();
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/runs/,
        response: {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 42001,
                status: "queued",
                conclusion: null,
                html_url: "https://github.com/org/repo/actions/runs/42001",
                name: "CI",
                created_at: futureTs,
                updated_at: futureTs,
              },
            ],
          },
        },
      });

      const result = await runTests({
        provider: "github-actions",
        repo: "org/repo",
        workflow: "ci.yml",
        branch: "main",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.provider).toBe("github-actions");
      expect(parsed.repo).toBe("org/repo");
      expect(parsed.run.id).toBe(42001);
      expect(parsed.run.status).toBe("queued");
      expect(parsed.run.html_url).toContain("42001");
    });

    it("defaults to ci.yml workflow when not specified", async () => {
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/dispatches/,
        method: "POST",
        response: { status: 204, body: {} },
      });

      const futureTs = new Date(Date.now() + 60000).toISOString();
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/runs/,
        response: {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 42002,
                status: "in_progress",
                conclusion: null,
                html_url: "https://github.com/org/repo/actions/runs/42002",
                name: "CI",
                created_at: futureTs,
                updated_at: futureTs,
              },
            ],
          },
        },
      });

      const result = await runTests({
        provider: "github-actions",
        repo: "org/repo",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.run.id).toBe(42002);
    });

    it("defaults to main branch when not specified", async () => {
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/dispatches/,
        method: "POST",
        response: { status: 204, body: {} },
      });

      const futureTs = new Date(Date.now() + 60000).toISOString();
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/runs/,
        response: {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 42003,
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/org/repo/actions/runs/42003",
                name: "CI",
                created_at: futureTs,
                updated_at: futureTs,
              },
            ],
          },
        },
      });

      const result = await runTests({
        provider: "github-actions",
        repo: "org/repo",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.run.conclusion).toBe("success");
    });

    it("returns placeholder run when polling finds no matching run", async () => {
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/dispatches/,
        method: "POST",
        response: { status: 204, body: {} },
      });

      // Polling always returns an OLD run (before triggerTime)
      const pastTs = new Date(Date.now() - 600000).toISOString();
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/runs/,
        response: {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 99,
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/org/repo/actions/runs/99",
                name: "CI",
                created_at: pastTs,
                updated_at: pastTs,
              },
            ],
          },
        },
      });

      // Override sleep so polling completes quickly
      vi.spyOn(global, "setTimeout").mockImplementation((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const result = await runTests({
        provider: "github-actions",
        repo: "org/repo",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      // Placeholder run has id 0
      expect(parsed.run.id).toBe(0);
      expect(parsed.run.status).toBe("queued");
    });
  });

  describe("error handling", () => {
    it("throws when GITHUB_TOKEN is not set", async () => {
      delete process.env.GITHUB_TOKEN;
      await expect(
        runTests({ provider: "github-actions", repo: "org/repo" })
      ).rejects.toThrow("GITHUB_TOKEN");
    });

    it("throws on GitHub API 404 (workflow not found)", async () => {
      mockFetch.addRoute({
        url: /\/actions\/workflows\/missing\.yml\/dispatches/,
        method: "POST",
        response: {
          status: 404,
          ok: false,
          statusText: "Not Found",
          text: "Workflow not found",
        },
      });

      await expect(
        runTests({
          provider: "github-actions",
          repo: "org/repo",
          workflow: "missing.yml",
        })
      ).rejects.toThrow("GitHub API error (404)");
    });
  });

  describe("audit logging", () => {
    it("creates an audit log entry on success", async () => {
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/dispatches/,
        method: "POST",
        response: { status: 204, body: {} },
      });

      const futureTs = new Date(Date.now() + 60000).toISOString();
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/runs/,
        response: {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 55000,
                status: "queued",
                conclusion: null,
                html_url: "https://github.com/org/repo/actions/runs/55000",
                name: "CI",
                created_at: futureTs,
                updated_at: futureTs,
              },
            ],
          },
        },
      });

      const logSpy = vi.spyOn(AuditLog.prototype, "log");

      await runTests({ provider: "github-actions", repo: "org/repo" });

      const call = logSpy.mock.calls.find(
        (c) => c[0].tool_name === "run_tests"
      );
      expect(call).toBeDefined();
      expect(call![0].success).toBe(true);
      expect(call![0].provider).toBe("github-actions");

      logSpy.mockRestore();
    });
  });

  describe("rate limit / 403 handling", () => {
    it("retries on 429 rate limit and succeeds", async () => {
      let dispatchCalls = 0;
      const originalFetch = globalThis.fetch;

      const futureTs = new Date(Date.now() + 60000).toISOString();

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        const method = opts?.method?.toUpperCase() ?? "GET";

        // First dispatch attempt — 429
        if (url.includes("dispatches") && method === "POST" && dispatchCalls === 0) {
          dispatchCalls++;
          return {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            headers: new Headers({ "retry-after": "0" }),
            text: async () => "rate limited",
            json: async () => ({}),
          } as unknown as Response;
        }

        // Second dispatch attempt — 204 success
        if (url.includes("dispatches") && method === "POST") {
          dispatchCalls++;
          return {
            ok: true,
            status: 204,
            statusText: "No Content",
            headers: new Headers(),
            json: async () => ({}),
            text: async () => "",
          } as unknown as Response;
        }

        // Runs polling
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "Content-Type": "application/json" }),
          json: async () => ({
            total_count: 1,
            workflow_runs: [
              {
                id: 77777,
                status: "queued",
                conclusion: null,
                html_url: "https://github.com/org/repo/actions/runs/77777",
                name: "CI",
                created_at: futureTs,
                updated_at: futureTs,
              },
            ],
          }),
          text: async () => "{}",
        } as unknown as Response;
      });

      const result = await runTests({
        provider: "github-actions",
        repo: "org/repo",
        workflow: "ci.yml",
      });

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.run.id).toBe(77777);

      globalThis.fetch = originalFetch;
    });
  });
});
