import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { signExecutionToken, parseSignedToken } from "../../src/lib/execution-token.ts";

// Set a known secret via process.env (no mock.module — compatible with same-process runs)
const originalSecret = process.env.EXECUTION_TOKEN_SECRET;

beforeAll(() => {
  process.env.EXECUTION_TOKEN_SECRET = "test-secret-for-hmac-signing-min32chars!!";
  _resetCacheForTesting();
});

afterAll(() => {
  process.env.EXECUTION_TOKEN_SECRET = originalSecret;
  _resetCacheForTesting();
});

describe("signExecutionToken", () => {
  it("returns executionId.signature format", () => {
    const token = signExecutionToken("exec_abc-123");
    expect(token).toStartWith("exec_abc-123.");
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[1]!.length).toBe(64); // SHA256 hex = 64 chars
  });

  it("produces deterministic output for same input", () => {
    const a = signExecutionToken("exec_xyz");
    const b = signExecutionToken("exec_xyz");
    expect(a).toBe(b);
  });

  it("produces different signatures for different executionIds", () => {
    const a = signExecutionToken("exec_aaa");
    const b = signExecutionToken("exec_bbb");
    expect(a).not.toBe(b);
  });
});

describe("parseSignedToken", () => {
  it("returns executionId for valid signed token", () => {
    const token = signExecutionToken("exec_test-id");
    const result = parseSignedToken(token);
    expect(result).toBe("exec_test-id");
  });

  it("returns null for unsigned executionId (no dot)", () => {
    expect(parseSignedToken("exec_test-id")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSignedToken("")).toBeNull();
  });

  it("returns null for tampered signature", () => {
    const token = signExecutionToken("exec_real");
    const tampered = token.slice(0, -4) + "0000";
    expect(parseSignedToken(tampered)).toBeNull();
  });

  it("returns null for forged token (valid format, wrong secret)", () => {
    const forged =
      "exec_stolen-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(parseSignedToken(forged)).toBeNull();
  });

  it("returns null for token with empty executionId", () => {
    expect(parseSignedToken(".abcdef1234567890")).toBeNull();
  });

  it("returns null for token with empty signature", () => {
    expect(parseSignedToken("exec_id.")).toBeNull();
  });

  it("handles executionId containing underscores and hyphens", () => {
    const id = "exec_a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const token = signExecutionToken(id);
    expect(parseSignedToken(token)).toBe(id);
  });
});
