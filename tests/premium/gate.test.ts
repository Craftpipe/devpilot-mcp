/**
 * Premium gate tests — isPro() and requirePro() with dynamic env reads.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPro, requirePro } from "../../src/premium/gate.js";

describe("isPro()", () => {
  const originalEnv = process.env.PRO_LICENSE;

  afterEach(() => {
    // Restore original env after each test
    if (originalEnv === undefined) {
      delete process.env.PRO_LICENSE;
    } else {
      process.env.PRO_LICENSE = originalEnv;
    }
  });

  it("returns false when PRO_LICENSE is not set", () => {
    delete process.env.PRO_LICENSE;
    expect(isPro()).toBe(false);
  });

  it("returns false when PRO_LICENSE is empty string", () => {
    process.env.PRO_LICENSE = "";
    expect(isPro()).toBe(false);
  });

  it("returns false when PRO_LICENSE does not start with CPK-", () => {
    process.env.PRO_LICENSE = "invalid-key-12345";
    expect(isPro()).toBe(false);
  });

  it("returns false when PRO_LICENSE is too short (< 8 chars)", () => {
    process.env.PRO_LICENSE = "CPK-1";
    expect(isPro()).toBe(false);
  });

  it("returns true with a valid CPK- prefixed key", () => {
    process.env.PRO_LICENSE = "CPK-valid-license-key-123";
    expect(isPro()).toBe(true);
  });

  it("returns true with minimum valid key (exactly 8 chars including CPK-)", () => {
    process.env.PRO_LICENSE = "CPK-1234"; // exactly 8 chars
    expect(isPro()).toBe(true);
  });

  it("reads dynamically — reflects env changes without restart", () => {
    delete process.env.PRO_LICENSE;
    expect(isPro()).toBe(false);

    process.env.PRO_LICENSE = "CPK-dynamic-test-key";
    expect(isPro()).toBe(true);

    delete process.env.PRO_LICENSE;
    expect(isPro()).toBe(false);
  });
});

describe("requirePro()", () => {
  const originalEnv = process.env.PRO_LICENSE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PRO_LICENSE;
    } else {
      process.env.PRO_LICENSE = originalEnv;
    }
  });

  it("throws when no license is set", () => {
    delete process.env.PRO_LICENSE;
    expect(() => requirePro("rollback_deploy")).toThrow(
      "[rollback_deploy] requires a Pro license"
    );
  });

  it("throws with the correct tool name in the error message", () => {
    delete process.env.PRO_LICENSE;
    expect(() => requirePro("incident_report")).toThrow("incident_report");
  });

  it("throws with upgrade URL in the error message", () => {
    delete process.env.PRO_LICENSE;
    expect(() => requirePro("deploy_pipeline")).toThrow(
      "https://craftpipe.dev/products/devpilot-mcp"
    );
  });

  it("throws with instruction to set PRO_LICENSE", () => {
    delete process.env.PRO_LICENSE;
    expect(() => requirePro("cost_monitor")).toThrow("PRO_LICENSE");
  });

  it("does NOT throw when a valid license is set", () => {
    process.env.PRO_LICENSE = "CPK-valid-license-key-123";
    expect(() => requirePro("rollback_deploy")).not.toThrow();
  });

  it("throws for invalid license (no CPK- prefix)", () => {
    process.env.PRO_LICENSE = "INVALID-KEY-1234567";
    expect(() => requirePro("audit_trail")).toThrow(
      "[audit_trail] requires a Pro license"
    );
  });

  it("throws for short license (< 8 chars)", () => {
    process.env.PRO_LICENSE = "CPK-1";
    expect(() => requirePro("environment_sync")).toThrow(
      "[environment_sync] requires a Pro license"
    );
  });
});
