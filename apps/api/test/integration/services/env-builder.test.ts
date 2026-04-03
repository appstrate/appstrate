// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for env-builder service.
 *
 * Tests ModelNotConfiguredError and signRunToken using the real
 * module graph (no mock.module needed — preload sets up DB/Redis/env).
 */

import { describe, expect, it } from "bun:test";
import { ModelNotConfiguredError } from "../../../src/services/env-builder.ts";
import { signRunToken, parseSignedToken } from "../../../src/lib/run-token.ts";

// ─── ModelNotConfiguredError ────────────────────────────────

describe("ModelNotConfiguredError", () => {
  it("is an instance of Error", () => {
    const err = new ModelNotConfiguredError();
    expect(err).toBeInstanceOf(Error);
  });

  it("has name set to ModelNotConfiguredError", () => {
    const err = new ModelNotConfiguredError();
    expect(err.name).toBe("ModelNotConfiguredError");
  });

  it("has the expected message", () => {
    const err = new ModelNotConfiguredError();
    expect(err.message).toBe("No LLM model configured for this organization");
  });

  it("produces a stack trace", () => {
    const err = new ModelNotConfiguredError();
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("ModelNotConfiguredError");
  });

  it("can be caught as a generic Error", () => {
    let caught: Error | undefined;
    try {
      throw new ModelNotConfiguredError();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(ModelNotConfiguredError);
    expect(caught).toBeInstanceOf(Error);
  });
});

// ─── signRunToken ──────────────────────────────────────

describe("signRunToken", () => {
  it("returns a string with runId and signature", () => {
    const token = signRunToken("exec_test-123");
    expect(typeof token).toBe("string");
    expect(token).toContain("exec_test-123");
  });

  it("token follows runId.signature format", () => {
    const execId = "exec_format-check";
    const token = signRunToken(execId);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(execId);
    expect(parts[1]!.length).toBe(64); // SHA256 hex = 64 chars
  });

  it("produces deterministic tokens for the same runId", () => {
    const a = signRunToken("exec_deterministic");
    const b = signRunToken("exec_deterministic");
    expect(a).toBe(b);
  });

  it("produces different tokens for different runIds", () => {
    const a = signRunToken("exec_aaa");
    const b = signRunToken("exec_bbb");
    expect(a).not.toBe(b);
  });
});

describe("parseSignedToken", () => {
  it("round-trips a valid signed token", () => {
    const runId = "exec_roundtrip-test";
    const token = signRunToken(runId);
    expect(parseSignedToken(token)).toBe(runId);
  });

  it("rejects a token with a tampered signature", () => {
    const token = signRunToken("exec_tamper");
    const tampered = token.slice(0, -4) + "dead";
    expect(parseSignedToken(tampered)).toBeNull();
  });

  it("rejects a token without a dot separator", () => {
    expect(parseSignedToken("notokenhere")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parseSignedToken("")).toBeNull();
  });
});
