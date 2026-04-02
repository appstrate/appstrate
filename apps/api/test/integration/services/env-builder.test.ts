// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for env-builder service.
 *
 * Tests ModelNotConfiguredError and buildRunApi using the real
 * module graph (no mock.module needed — preload sets up DB/Redis/env).
 */

import { describe, expect, it } from "bun:test";
import { ModelNotConfiguredError, buildRunApi } from "../../../src/services/env-builder.ts";

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

// ─── buildRunApi ──────────────────────────────────────

describe("buildRunApi", () => {
  it("returns an object with url and token properties", () => {
    const result = buildRunApi("exec_test-123");
    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("token");
    expect(typeof result.url).toBe("string");
    expect(typeof result.token).toBe("string");
  });

  it("token contains the runId", () => {
    const execId = "exec_abc-def-789";
    const result = buildRunApi(execId);
    expect(result.token).toContain(execId);
  });

  it("token follows runId.signature format", () => {
    const execId = "exec_format-check";
    const result = buildRunApi(execId);
    const parts = result.token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(execId);
    expect(parts[1]!.length).toBe(64); // SHA256 hex = 64 chars
  });

  it("produces deterministic tokens for the same executionId", () => {
    const a = buildRunApi("exec_deterministic");
    const b = buildRunApi("exec_deterministic");
    expect(a.token).toBe(b.token);
    expect(a.url).toBe(b.url);
  });

  it("produces different tokens for different runIds", () => {
    const a = buildRunApi("exec_aaa");
    const b = buildRunApi("exec_bbb");
    expect(a.token).not.toBe(b.token);
  });
});
