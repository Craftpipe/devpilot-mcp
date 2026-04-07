/**
 * GitHubActionsAdapter tests.
 * Covers listWorkflows, triggerWorkflow (with polling), getWorkflowStatus.
 * Verifies 429 and 403 rate limit handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { GitHubActionsAdapter } from "../../src/adapters/github-actions.js";

describe("GitHubActionsAdapter", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let adapter: GitHubActionsAdapter;

  beforeEach(() => {
    mockFetch = createMockFetch();
    process.env.GITHUB_TOKEN = "test-github-token";
    adapter = new GitHubActionsAdapter();
  });

  afterEach(() => {
    mockFetch.restore();
    delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("throws when GITHUB_TOKEN is not set", () => {
      delete process.env.GITHUB_TOKEN;
      expect(() => new GitHubActionsAdapter()).toThrow("GITHUB_TOKEN");
    });

    it("creates adapter when token is set", () => {
      expect(adapter.name).toBe("github-actions");
    });
  });

  describe("listWorkflows()", () => {
    it("returns list of workflows", async () => {
      mockFetch.addRoute({
        url: /\/repos\/org\/repo\/actions\/workflows/,
        response: {
          body: {
            total_count: 2,
            workflows: [
              { id: 1001, name: "CI", path: ".github/workflows/ci.yml" },
              { id: 1002, name: "Deploy", path: ".github/workflows/deploy.yml" },
            ],
          },
        },
      });

      const workflows = await adapter.listWorkflows("org/repo");
      expect(workflows).toHaveLength(2);
      expect(workflows[0]!.id).toBe(1001);
      expect(workflows[0]!.name).toBe("CI");
      expect(workflows[0]!.path).toBe(".github/workflows/ci.yml");
    });

    it("returns empty array when no workflows", async () => {
      mockFetch.addRoute({
        url: /\/repos\/org\/repo\/actions\/workflows/,
        response: { body: { total_count: 0, workflows: [] } },
      });

      const workflows = await adapter.listWorkflows("org/repo");
      expect(workflows).toHaveLength(0);
    });
  });

  describe("triggerWorkflow()", () => {
    it("dispatches workflow and returns run found by polling", async () => {
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
                id: 88001,
                status: "queued",
                conclusion: null,
                html_url: "https://github.com/org/repo/actions/runs/88001",
                name: "CI",
                created_at: futureTs,
                updated_at: futureTs,
              },
            ],
          },
        },
      });

      const run = await adapter.triggerWorkflow("org/repo", "ci.yml", "main");
      expect(run.id).toBe(88001);
      expect(run.status).toBe("queued");
      expect(run.workflow_name).toBe("CI");
    });

    it("returns placeholder run when polling finds no matching run", async () => {
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/dispatches/,
        method: "POST",
        response: { status: 204, body: {} },
      });

      // Always returns old run (before trigger time)
      const pastTs = new Date(Date.now() - 600000).toISOString();
      mockFetch.addRoute({
        url: /\/actions\/workflows\/ci\.yml\/runs/,
        response: {
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 1,
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/org/repo/actions/runs/1",
                name: "CI",
                created_at: pastTs,
                updated_at: pastTs,
              },
            ],
          },
        },
      });

      // Mock setTimeout to skip delay
      vi.spyOn(global, "setTimeout").mockImplementation((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const run = await adapter.triggerWorkflow("org/repo", "ci.yml", "main");
      expect(run.id).toBe(0);
      expect(run.status).toBe("queued");
    });

    it("throws when dispatch returns 404 (workflow not found)", async () => {
      mockFetch.addRoute({
        url: /\/actions\/workflows\/bad\.yml\/dispatches/,
        method: "POST",
        response: {
          status: 404,
          ok: false,
          statusText: "Not Found",
          text: "workflow not found",
        },
      });

      await expect(
        adapter.triggerWorkflow("org/repo", "bad.yml", "main")
      ).rejects.toThrow("GitHub API error (404)");
    });

    it("passes workflow inputs to dispatch request", async () => {
      let capturedBody: string | null = null;
      const originalFetch = globalThis.fetch;

      const futureTs = new Date(Date.now() + 60000).toISOString();

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (String(url).includes("dispatches")) {
          capturedBody = opts?.body as string;
          return {
            ok: true,
            status: 204,
            statusText: "No Content",
            headers: new Headers(),
            json: async () => ({}),
            text: async () => "",
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "Content-Type": "application/json" }),
          json: async () => ({
            total_count: 1,
            workflow_runs: [{
              id: 99001,
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/org/repo/actions/runs/99001",
              name: "CI",
              created_at: futureTs,
              updated_at: futureTs,
            }],
          }),
          text: async () => "{}",
        } as unknown as Response;
      });

      await adapter.triggerWorkflow("org/repo", "ci.yml", "feature/test", {
        environment: "staging",
      });

      expect(capturedBody).not.toBeNull();
      const body = JSON.parse(capturedBody!);
      expect(body.ref).toBe("feature/test");
      expect(body.inputs).toEqual({ environment: "staging" });

      globalThis.fetch = originalFetch;
    });
  });

  describe("getWorkflowStatus()", () => {
    it("returns mapped workflow run status", async () => {
      mockFetch.addRoute({
        url: /\/repos\/org\/repo\/actions\/runs\/12345/,
        response: {
          body: {
            id: 12345,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/org/repo/actions/runs/12345",
            name: "CI",
            created_at: "2024-01-15T10:00:00.000Z",
            updated_at: "2024-01-15T10:30:00.000Z",
          },
        },
      });

      const run = await adapter.getWorkflowStatus("org/repo", 12345);
      expect(run.id).toBe(12345);
      expect(run.status).toBe("completed");
      expect(run.conclusion).toBe("success");
      expect(run.html_url).toContain("12345");
    });

    it("returns run with failure conclusion", async () => {
      mockFetch.addRoute({
        url: /\/repos\/org\/repo\/actions\/runs\/99999/,
        response: {
          body: {
            id: 99999,
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/org/repo/actions/runs/99999",
            name: "CI",
            created_at: "2024-01-15T10:00:00.000Z",
            updated_at: "2024-01-15T10:15:00.000Z",
          },
        },
      });

      const run = await adapter.getWorkflowStatus("org/repo", 99999);
      expect(run.conclusion).toBe("failure");
    });
  });

  describe("rate limit handling — 429", () => {
    it("retries on 429 and succeeds on second attempt", async () => {
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
          json: async () => ({ total_count: 0, workflows: [] }),
          text: async () => "{}",
        } as unknown as Response;
      });

      const workflows = await adapter.listWorkflows("org/repo");
      expect(workflows).toHaveLength(0);
      expect(callCount).toBe(2);

      globalThis.fetch = originalFetch;
    });

    it("throws when second attempt also returns 429", async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "retry-after": "0", "x-ratelimit-remaining": "0" }),
        text: async () => "rate limited",
        json: async () => ({}),
      } as unknown as Response);

      await expect(adapter.listWorkflows("org/repo")).rejects.toThrow(
        "GitHub API rate limited"
      );

      globalThis.fetch = originalFetch;
    });
  });

  describe("rate limit handling — 403", () => {
    it("retries on 403 (GitHub rate limit) and succeeds", async () => {
      let callCount = 0;
      const originalFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 403,
            statusText: "Forbidden",
            headers: new Headers({ "x-ratelimit-reset": String(Math.floor(Date.now() / 1000)) }),
            text: async () => "API rate limit exceeded",
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "Content-Type": "application/json" }),
          json: async () => ({ total_count: 0, workflows: [] }),
          text: async () => "{}",
        } as unknown as Response;
      });

      const workflows = await adapter.listWorkflows("org/repo");
      expect(workflows).toHaveLength(0);
      expect(callCount).toBe(2);

      globalThis.fetch = originalFetch;
    });

    it("throws when 403 persists after retry", async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: new Headers({ "x-ratelimit-remaining": "0" }),
        text: async () => "API rate limit exceeded",
        json: async () => ({}),
      } as unknown as Response);

      await expect(adapter.listWorkflows("org/repo")).rejects.toThrow(
        "GitHub API rate limited"
      );

      globalThis.fetch = originalFetch;
    });
  });
});
