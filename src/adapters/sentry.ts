/**
 * Sentry API adapter.
 * Implements ErrorProvider interface using Sentry's REST API.
 * Auth: Bearer SENTRY_AUTH_TOKEN + SENTRY_ORG env var
 */

import type { ErrorProvider, ErrorEvent, ErrorDetail } from "./types.js";

const BASE_URL = "https://sentry.io";

// --- Sentry API response shapes ---

interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  level: string;
  shortId: string;
}

interface SentryEventEntry {
  type: string;
  data: {
    values?: {
      stacktrace?: {
        frames?: {
          filename?: string;
          function?: string;
          lineNo?: number;
        }[];
      };
    }[];
  };
}

interface SentryEvent {
  id: string;
  title?: string;
  culprit?: string;
  entries?: SentryEventEntry[];
  tags?: { key: string; value: string }[];
  contexts?: Record<string, unknown>;
}

// --- Adapter ---

export class SentryAdapter implements ErrorProvider {
  readonly name = "sentry";
  private readonly token: string;
  private readonly org: string;

  constructor() {
    const token = process.env.SENTRY_AUTH_TOKEN;
    if (!token) {
      throw new Error(
        "SENTRY_AUTH_TOKEN not set. Add it to your environment to use Sentry tools. " +
          "Get a token at https://sentry.io/settings/account/api/auth-tokens/"
      );
    }
    const org = process.env.SENTRY_ORG;
    if (!org) {
      throw new Error(
        "SENTRY_ORG not set. Set it to your Sentry organization slug. " +
          "Find it at https://sentry.io/settings/"
      );
    }
    this.token = token;
    this.org = org;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const fetchOpts: RequestInit = {
      headers: { Authorization: `Bearer ${this.token}` },
    };

    let res = await fetch(url, fetchOpts);

    // Rate limit handling
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 60000)
        : 10000;
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetch(url, fetchOpts);

      if (res.status === 429) {
        throw new Error(
          `Sentry rate limited. Retry after ${retryAfter ?? "unknown"} seconds.`
        );
      }
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Sentry API error (${res.status}): ${res.statusText} — ${body}`
      );
    }

    return res.json() as Promise<T>;
  }

  private mapTimeframe(timeframe: string): string {
    // Sentry uses statsPeriod param: "1h", "24h", "7d"
    return timeframe;
  }

  async getErrors(
    projectSlug: string,
    timeframe: string,
    limit: number
  ): Promise<ErrorEvent[]> {
    if (!projectSlug) {
      throw new Error(
        "project_slug is required for Sentry error fetching. " +
          "Find your project slug at https://sentry.io/settings/"
      );
    }

    const period = this.mapTimeframe(timeframe);
    const path =
      `/api/0/projects/${encodeURIComponent(this.org)}/${encodeURIComponent(projectSlug)}/issues/` +
      `?query=is:unresolved&statsPeriod=${period}&limit=${limit}`;

    const issues = await this.request<SentryIssue[]>(path);

    return (issues ?? []).map((issue) => ({
      id: issue.id,
      title: issue.title,
      culprit: issue.culprit,
      count: parseInt(issue.count, 10) || 0,
      first_seen: issue.firstSeen,
      last_seen: issue.lastSeen,
      level: issue.level,
      short_id: issue.shortId,
    }));
  }

  async getErrorDetails(errorId: string): Promise<ErrorDetail> {
    const issue = await this.request<SentryIssue>(
      `/api/0/issues/${encodeURIComponent(errorId)}/`
    );

    const latestEvent = await this.request<SentryEvent>(
      `/api/0/issues/${encodeURIComponent(errorId)}/events/latest/`
    );

    // Extract stack trace from the event entries
    const exceptionEntry = (latestEvent.entries ?? []).find(
      (e) => e.type === "exception"
    );
    const frames =
      exceptionEntry?.data?.values?.[0]?.stacktrace?.frames ?? [];
    const stackTrace = frames
      .map((f) => `  at ${f.function ?? "?"}(${f.filename ?? "?"}:${f.lineNo ?? "?"})`)
      .join("\n");

    // Convert tag array to object
    const tags: Record<string, string> = {};
    for (const tag of latestEvent.tags ?? []) {
      tags[tag.key] = tag.value;
    }

    return {
      id: issue.id,
      title: issue.title,
      culprit: issue.culprit,
      count: parseInt(issue.count, 10) || 0,
      first_seen: issue.firstSeen,
      last_seen: issue.lastSeen,
      level: issue.level,
      short_id: issue.shortId,
      stack_trace: stackTrace,
      tags,
      contexts: (latestEvent.contexts ?? {}) as Record<string, unknown>,
    };
  }
}
