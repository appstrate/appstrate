// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for run-context-builder service.
 *
 * Tests ModelNotConfiguredError and signRunToken using the real
 * module graph (no mock.module needed — preload sets up DB/Redis/env).
 */

import { describe, expect, it } from "bun:test";
import {
  ModelNotConfiguredError,
  ModelCredentialMissingError,
  modelCredentialIsPresent,
} from "../../../src/services/run-context-builder.ts";
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

// ─── modelCredentialIsPresent ──────────────────────────────

describe("modelCredentialIsPresent", () => {
  it("returns true for a non-empty key", () => {
    expect(modelCredentialIsPresent({ apiKey: "sk-abc123" })).toBe(true);
  });

  it("returns false for an empty-string key (the system-stub hang case)", () => {
    expect(modelCredentialIsPresent({ apiKey: "" })).toBe(false);
  });

  it("returns false for a whitespace-only key", () => {
    expect(modelCredentialIsPresent({ apiKey: "   " })).toBe(false);
    expect(modelCredentialIsPresent({ apiKey: "\t\n" })).toBe(false);
  });

  it("returns true for a key with surrounding whitespace but real content", () => {
    expect(modelCredentialIsPresent({ apiKey: "  sk-real  " })).toBe(true);
  });
});

// ─── ModelCredentialMissingError ───────────────────────────

describe("ModelCredentialMissingError", () => {
  it("is an instance of Error", () => {
    expect(new ModelCredentialMissingError("GPT-5")).toBeInstanceOf(Error);
  });

  it("has name set to ModelCredentialMissingError", () => {
    expect(new ModelCredentialMissingError("GPT-5").name).toBe("ModelCredentialMissingError");
  });

  it("carries the model label and mentions it in the message", () => {
    const err = new ModelCredentialMissingError("Claude Opus");
    expect(err.modelLabel).toBe("Claude Opus");
    expect(err.message).toContain("Claude Opus");
    expect(err.message).toContain("no API key");
  });

  it("is distinguishable from ModelNotConfiguredError via instanceof", () => {
    const err: Error = new ModelCredentialMissingError("X");
    expect(err instanceof ModelCredentialMissingError).toBe(true);
    expect(err instanceof ModelNotConfiguredError).toBe(false);
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
