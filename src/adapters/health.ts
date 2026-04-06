/**
 * HTTP health check adapter.
 * Performs GET requests to URLs and reports up/down status.
 * Uses AbortController for timeout handling.
 * No auth required — checks are read-only GET requests.
 */

import type { HealthProvider, HealthResult } from "./types.js";

export class HealthAdapter implements HealthProvider {
  async check(
    urls: string[],
    timeout: number = 5000,
    expectedStatus: number = 200
  ): Promise<HealthResult[]> {
    return Promise.all(
      urls.map((url) => this.checkOne(url, timeout, expectedStatus))
    );
  }

  private async checkOne(
    url: string,
    timeout: number,
    expectedStatus: number
  ): Promise<HealthResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const response_time_ms = Date.now() - start;
      const isUp = res.status === expectedStatus;

      return {
        url,
        status: isUp ? "up" : "down",
        status_code: res.status,
        response_time_ms,
        ...(isUp
          ? {}
          : {
              error: `Expected status ${expectedStatus}, got ${res.status}`,
            }),
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const response_time_ms = Date.now() - start;

      const isTimeout =
        err instanceof Error && err.name === "AbortError";

      return {
        url,
        status: "down",
        status_code: null,
        response_time_ms,
        error: isTimeout
          ? `Timeout after ${timeout}ms`
          : err instanceof Error
          ? err.message
          : "Unknown error",
      };
    }
  }
}
