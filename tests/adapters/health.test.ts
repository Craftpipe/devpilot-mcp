/**
 * HealthAdapter tests.
 * Covers up/down/timeout scenarios, custom expectedStatus, multiple URLs.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { HealthAdapter } from "../../src/adapters/health.js";

describe("HealthAdapter", () => {
  const adapter = new HealthAdapter();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("single URL — up", () => {
    it("returns up status for 200 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
      } as unknown as Response);

      const results = await adapter.check(["https://example.com"], 5000);
      expect(results).toHaveLength(1);
      expect(results[0]!.url).toBe("https://example.com");
      expect(results[0]!.status).toBe("up");
      expect(results[0]!.status_code).toBe(200);
      expect(typeof results[0]!.response_time_ms).toBe("number");
      expect(results[0]!.error).toBeUndefined();
    });

    it("uses 200 as default expected status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
      } as unknown as Response);

      const results = await adapter.check(["https://example.com"]);
      expect(results[0]!.status).toBe("up");
    });

    it("response_time_ms is a non-negative number", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
      } as unknown as Response);

      const results = await adapter.check(["https://example.com"], 5000);
      expect(results[0]!.response_time_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe("single URL — down", () => {
    it("returns down status for 503 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
      } as unknown as Response);

      const results = await adapter.check(["https://down.example.com"]);
      expect(results[0]!.status).toBe("down");
      expect(results[0]!.status_code).toBe(503);
      expect(results[0]!.error).toContain("503");
    });

    it("returns down for 404 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      } as unknown as Response);

      const results = await adapter.check(["https://notfound.example.com"]);
      expect(results[0]!.status).toBe("down");
      expect(results[0]!.status_code).toBe(404);
    });

    it("returns down for 500 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
      } as unknown as Response);

      const results = await adapter.check(["https://error.example.com"]);
      expect(results[0]!.status).toBe("down");
    });

    it("includes expected vs actual status in error message", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      } as unknown as Response);

      const results = await adapter.check(["https://example.com"]);
      expect(results[0]!.error).toContain("Expected status 200");
      expect(results[0]!.error).toContain("404");
    });
  });

  describe("custom expectedStatus", () => {
    it("returns up when actual status matches custom expectedStatus", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 301,
        headers: new Headers(),
      } as unknown as Response);

      // Expecting a redirect (301)
      const results = await adapter.check(["https://redirect.example.com"], 5000, 301);
      expect(results[0]!.status).toBe("up");
      expect(results[0]!.status_code).toBe(301);
    });

    it("returns down when status does not match custom expectedStatus", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
      } as unknown as Response);

      // Expecting 201 but got 200
      const results = await adapter.check(["https://example.com"], 5000, 201);
      expect(results[0]!.status).toBe("down");
    });
  });

  describe("timeout handling", () => {
    it("returns down with timeout error on AbortError", async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(
        Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
      );

      const results = await adapter.check(["https://slow.example.com"], 100);
      expect(results[0]!.status).toBe("down");
      expect(results[0]!.status_code).toBeNull();
      expect(results[0]!.error).toContain("Timeout after 100ms");
    });

    it("returns down with error message on network failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(
        new Error("ECONNREFUSED 127.0.0.1:80")
      );

      const results = await adapter.check(["https://unreachable.example.com"]);
      expect(results[0]!.status).toBe("down");
      expect(results[0]!.status_code).toBeNull();
      expect(results[0]!.error).toContain("ECONNREFUSED");
    });

    it("returns down with unknown error for non-Error throws", async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce("string error");

      const results = await adapter.check(["https://example.com"]);
      expect(results[0]!.status).toBe("down");
      expect(results[0]!.error).toBe("Unknown error");
    });
  });

  describe("multiple URLs", () => {
    it("checks multiple URLs in parallel and returns all results", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() } as unknown as Response)
        .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() } as unknown as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() } as unknown as Response);

      const results = await adapter.check([
        "https://site1.example.com",
        "https://site2.example.com",
        "https://site3.example.com",
      ]);

      expect(results).toHaveLength(3);

      const site1 = results.find((r) => r.url === "https://site1.example.com");
      const site2 = results.find((r) => r.url === "https://site2.example.com");
      const site3 = results.find((r) => r.url === "https://site3.example.com");

      expect(site1!.status).toBe("up");
      expect(site2!.status).toBe("down");
      expect(site3!.status).toBe("up");
    });

    it("handles mixed timeout and success results", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() } as unknown as Response)
        .mockRejectedValueOnce(
          Object.assign(new Error("aborted"), { name: "AbortError" })
        );

      const results = await adapter.check(
        ["https://good.example.com", "https://slow.example.com"],
        500
      );

      expect(results).toHaveLength(2);
      const good = results.find((r) => r.url === "https://good.example.com");
      const slow = results.find((r) => r.url === "https://slow.example.com");

      expect(good!.status).toBe("up");
      expect(slow!.status).toBe("down");
      expect(slow!.error).toContain("Timeout after 500ms");
    });

    it("returns empty array when no URLs provided", async () => {
      const results = await adapter.check([]);
      expect(results).toHaveLength(0);
    });
  });
});
