/**
 * Shared fetch mock utility for adapter tests.
 * Provides route-based mocking via createMockFetch() and
 * a simple one-liner mockFetchOnce() for simple cases.
 */

import { vi, type Mock } from "vitest";

export interface MockRoute {
  /** URL pattern — string for substring match, RegExp for pattern match */
  url: string | RegExp;
  /** HTTP method (default: any) */
  method?: string;
  /** Response to return */
  response: MockFetchResponse;
}

export interface MockFetchResponse {
  status?: number;
  statusText?: string;
  ok?: boolean;
  headers?: Record<string, string>;
  body?: unknown;
  /** For non-JSON responses */
  text?: string;
}

/**
 * Create a mock fetch function with pre-configured routes.
 *
 * Usage:
 * ```ts
 * const { mockFetch, addRoute, restore } = createMockFetch();
 *
 * addRoute({
 *   url: /\/v6\/deployments/,
 *   response: { body: { deployments: [] } },
 * });
 *
 * const adapter = new VercelAdapter();
 * const result = await adapter.getDeployments("prj_test");
 * restore();
 * ```
 */
export function createMockFetch() {
  const routes: MockRoute[] = [];
  const originalFetch = globalThis.fetch;

  const mockFn: Mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
      const method = (init?.method?.toUpperCase()) ?? "GET";

      const match = routes.find((r) => {
        const urlMatch =
          typeof r.url === "string" ? url.includes(r.url) : r.url.test(url);
        const methodMatch = !r.method || r.method.toUpperCase() === method;
        return urlMatch && methodMatch;
      });

      if (!match) {
        return new Response(
          JSON.stringify({ error: `No mock route for ${method} ${url}` }),
          {
            status: 404,
            statusText: "Not Found (mock)",
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const { response: r } = match;
      const status = r.status ?? 200;
      const ok = r.ok ?? (status >= 200 && status < 300);
      const headers = new Headers({
        "Content-Type": "application/json",
        ...(r.headers ?? {}),
      });

      const bodyStr = r.text ?? JSON.stringify(r.body ?? {});

      return {
        ok,
        status,
        statusText: r.statusText ?? (ok ? "OK" : "Error"),
        headers,
        json: async () => (r.body !== undefined ? r.body : JSON.parse(bodyStr)),
        text: async () => bodyStr,
        clone: () => ({
          json: async () => r.body,
          text: async () => bodyStr,
          ok,
          status,
          headers,
        }),
      } as unknown as Response;
    }
  );

  // Install mock globally
  globalThis.fetch = mockFn as unknown as typeof fetch;

  function addRoute(route: MockRoute) {
    routes.push(route);
  }

  function clearRoutes() {
    routes.length = 0;
  }

  function restore() {
    globalThis.fetch = originalFetch;
    routes.length = 0;
  }

  return { mockFetch: mockFn, addRoute, clearRoutes, restore };
}

/**
 * Quick one-liner to mock fetch for a single response.
 * Returns the mock function and a restore callback.
 */
export function mockFetchOnce(body: unknown, status: number = 200) {
  const originalFetch = globalThis.fetch;
  const mockFn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status < 400 ? "OK" : "Error",
    headers: new Headers({ "Content-Type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));

  globalThis.fetch = mockFn as unknown as typeof fetch;

  return {
    mockFn,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
