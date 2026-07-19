// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `toolTimeoutMsFromEnv` (#779 annex) — the operator override
 * for the per-call MCP tool timeout applied to integration clients.
 * Absent/invalid → undefined → the MCP SDK default is used.
 */

import { describe, it, expect } from "bun:test";
import {
  toolTimeoutMsFromEnv,
  scrubStderrLine,
  shouldSuppressIntegrationStderr,
} from "../integrations-boot.ts";

describe("toolTimeoutMsFromEnv", () => {
  it("returns undefined when the var is absent", () => {
    expect(toolTimeoutMsFromEnv({})).toBeUndefined();
  });

  it("parses a positive integer", () => {
    expect(toolTimeoutMsFromEnv({ APPSTRATE_MCP_TOOL_TIMEOUT_MS: "120000" })).toBe(120_000);
  });

  it("floors a fractional value", () => {
    expect(toolTimeoutMsFromEnv({ APPSTRATE_MCP_TOOL_TIMEOUT_MS: "1500.9" })).toBe(1_500);
  });

  it("returns undefined for zero, negative, or non-numeric values", () => {
    expect(toolTimeoutMsFromEnv({ APPSTRATE_MCP_TOOL_TIMEOUT_MS: "0" })).toBeUndefined();
    expect(toolTimeoutMsFromEnv({ APPSTRATE_MCP_TOOL_TIMEOUT_MS: "-5" })).toBeUndefined();
    expect(toolTimeoutMsFromEnv({ APPSTRATE_MCP_TOOL_TIMEOUT_MS: "soon" })).toBeUndefined();
    expect(toolTimeoutMsFromEnv({ APPSTRATE_MCP_TOOL_TIMEOUT_MS: "" })).toBeUndefined();
  });
});

describe("scrubStderrLine (#779)", () => {
  it("redacts Bearer / Basic auth tokens", () => {
    expect(scrubStderrLine("Authorization: Bearer sk-abc123XYZ.def")).not.toContain("sk-abc123XYZ");
    expect(scrubStderrLine("used Basic aWQ6c2VjcmV0")).toContain("[redacted]");
  });

  it("redacts JWTs and provider key prefixes", () => {
    expect(scrubStderrLine("token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toContain("[redacted");
    expect(scrubStderrLine("key ghp_ABCdef123456789")).toContain("[redacted-key]");
  });

  it("redacts separator-less AWS access-key ids and dotted Google OAuth tokens", () => {
    // AKIA keys have NO separator after the prefix; ya29 tokens use a dot —
    // both would escape the `[-_]`-anchored family regex without their own
    // literal shapes.
    expect(scrubStderrLine("aws error for key AKIAIOSFODNN7EXAMPLE")).not.toContain(
      "AKIAIOSFODNN7EXAMPLE",
    );
    expect(scrubStderrLine("got ya29.a0AfH6SMBx-abc_123")).not.toContain("ya29.a0AfH6SMBx");
  });

  it("does not redact prose words starting with a key prefix", () => {
    expect(scrubStderrLine("found skeletons in pkgroots directory")).toBe(
      "found skeletons in pkgroots directory",
    );
  });

  it("redacts key=value credential shapes", () => {
    const out = scrubStderrLine("refresh_token=1//0abcDEF-xyz other stuff");
    expect(out).not.toContain("1//0abcDEF-xyz");
    expect(out).toContain("[redacted]");
  });

  it("leaves an ordinary diagnostic line intact", () => {
    const line = "[qbo-client] Token refresh failed (status code 405); falling back";
    // The word "Token" without a value shape survives — this is the exact
    // #779 QBO diagnostic operators need to see.
    expect(scrubStderrLine(line)).toContain("status code 405");
  });

  it("caps line length", () => {
    expect(scrubStderrLine("x".repeat(2000)).length).toBeLessThanOrEqual(500);
  });
});

describe("browser integration stderr policy", () => {
  it("suppresses every browser runner because it can contain CDP or bootstrap secrets", () => {
    expect(shouldSuppressIntegrationStderr({ browser: undefined })).toBe(false);
    expect(
      shouldSuppressIntegrationStderr({
        browser: {
          purpose: "connection-acquisition",
          protocol: "cdp-v1",
          profile: "standard",
          allowedOrigins: ["https://example.com"],
          sessionMode: "exportable",
          trustedDriver: true,
        },
      }),
    ).toBe(true);
  });
});
