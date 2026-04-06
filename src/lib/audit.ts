/**
 * Audit trail module — SQLite-backed logging of all DevPilot tool calls.
 * Stores to ~/.devpilot/audit.db by default.
 * 90-day retention with automatic cleanup on init.
 */

import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";

export interface AuditLogEntry {
  tool_name: string;
  provider: string;
  input_summary: string;
  result_summary: string;
  success: boolean;
  duration_ms?: number;
}

export interface AuditRow {
  id: number;
  timestamp: string;
  tool_name: string;
  provider: string;
  input_summary: string;
  result_summary: string;
  success: number; // SQLite stores booleans as integers
  duration_ms: number | null;
}

export interface AuditQueryOptions {
  timeframe?: "1d" | "7d" | "30d";
  tool_name?: string;
  provider?: string;
  limit?: number;
}

// Sensitive key patterns to redact from input summaries
const SENSITIVE_PATTERNS = [
  /token/i,
  /password/i,
  /secret/i,
  /api_key/i,
  /auth/i,
  /credential/i,
  /private/i,
];

export class AuditLog {
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? this.defaultPath();
    this.db = new Database(path);
    this.init();
  }

  private defaultPath(): string {
    const dir = join(homedir(), ".devpilot");
    mkdirSync(dir, { recursive: true });
    return join(dir, "audit.db");
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now')),
        tool_name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        input_summary TEXT NOT NULL DEFAULT '',
        result_summary TEXT NOT NULL DEFAULT '',
        success INTEGER DEFAULT 1,
        duration_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool_name);
    `);

    // 90-day cleanup on init (Fix 10)
    this.db.exec(
      "DELETE FROM audit_log WHERE timestamp < datetime('now', '-90 days')"
    );
  }

  /**
   * Sanitize input record — redact any values whose key looks like a secret.
   * Values are truncated to 200 chars to keep audit.db small.
   */
  sanitize(input: Record<string, unknown>): string {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const isSensitive = SENSITIVE_PATTERNS.some((p) => p.test(key));
      if (isSensitive) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "string" && value.length > 200) {
        sanitized[key] = value.substring(0, 200) + "…";
      } else {
        sanitized[key] = value;
      }
    }
    return JSON.stringify(sanitized);
  }

  log(entry: AuditLogEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (tool_name, provider, input_summary, result_summary, success, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.tool_name,
      entry.provider ?? "",
      entry.input_summary,
      entry.result_summary?.substring(0, 500) ?? "",
      entry.success ? 1 : 0,
      entry.duration_ms ?? null
    );
  }

  query(opts: AuditQueryOptions = {}): AuditRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.timeframe) {
      const days = opts.timeframe === "1d" ? 1 : opts.timeframe === "7d" ? 7 : 30;
      conditions.push(`timestamp >= datetime('now', '-${days} days')`);
    }

    if (opts.tool_name) {
      conditions.push("tool_name = ?");
      params.push(opts.tool_name);
    }

    if (opts.provider) {
      conditions.push("provider = ?");
      params.push(opts.provider);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;

    const sql = `
      SELECT id, timestamp, tool_name, provider, input_summary, result_summary, success, duration_ms
      FROM audit_log
      ${where}
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    return this.db.prepare(sql).all(...params, limit) as AuditRow[];
  }

  close(): void {
    this.db.close();
  }
}
