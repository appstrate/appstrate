/**
 * Integration tests for env-builder service.
 *
 * Tests ModelNotConfiguredError and buildExecutionApi using the real
 * module graph (no mock.module needed — preload sets up DB/Redis/env).
 */

import { describe, expect, it } from "bun:test";
import {
  ModelNotConfiguredError,
  buildExecutionApi,
} from "../../../src/services/env-builder.ts";

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

// ─── buildExecutionApi ──────────────────────────────────────

describe("buildExecutionApi", () => {
  it("returns an object with url and token properties", () => {
    const result = buildExecutionApi("exec_test-123");
    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("token");
    expect(typeof result.url).toBe("string");
    expect(typeof result.token).toBe("string");
  });

  it("token contains the executionId", () => {
    const execId = "exec_abc-def-789";
    const result = buildExecutionApi(execId);
    expect(result.token).toContain(execId);
  });

  it("token follows executionId.signature format", () => {
    const execId = "exec_format-check";
    const result = buildExecutionApi(execId);
    const parts = result.token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(execId);
    expect(parts[1]!.length).toBe(64); // SHA256 hex = 64 chars
  });

  it("produces deterministic tokens for the same executionId", () => {
    const a = buildExecutionApi("exec_deterministic");
    const b = buildExecutionApi("exec_deterministic");
    expect(a.token).toBe(b.token);
    expect(a.url).toBe(b.url);
  });

  it("produces different tokens for different executionIds", () => {
    const a = buildExecutionApi("exec_aaa");
    const b = buildExecutionApi("exec_bbb");
    expect(a.token).not.toBe(b.token);
  });
});
