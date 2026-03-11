import { describe, expect, test, mock } from "bun:test";

// Mock @appstrate/env before importing the module under test
const MOCK_SECRET = "test-secret-for-hmac-signing-min32chars!!";
mock.module("@appstrate/env", () => ({
  getEnv: () => ({ BETTER_AUTH_SECRET: MOCK_SECRET }),
}));

const { signExecutionToken, parseSignedToken } = await import("../execution-token.ts");

describe("signExecutionToken", () => {
  test("returns executionId.signature format", () => {
    const token = signExecutionToken("exec_abc-123");
    expect(token).toStartWith("exec_abc-123.");
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[1]!.length).toBe(64); // SHA256 hex = 64 chars
  });

  test("produces deterministic output for same input", () => {
    const a = signExecutionToken("exec_xyz");
    const b = signExecutionToken("exec_xyz");
    expect(a).toBe(b);
  });

  test("produces different signatures for different executionIds", () => {
    const a = signExecutionToken("exec_aaa");
    const b = signExecutionToken("exec_bbb");
    expect(a).not.toBe(b);
  });
});

describe("parseSignedToken", () => {
  test("returns executionId for valid signed token", () => {
    const token = signExecutionToken("exec_test-id");
    const result = parseSignedToken(token);
    expect(result).toBe("exec_test-id");
  });

  test("returns null for unsigned executionId (no dot)", () => {
    expect(parseSignedToken("exec_test-id")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSignedToken("")).toBeNull();
  });

  test("returns null for tampered signature", () => {
    const token = signExecutionToken("exec_real");
    const tampered = token.slice(0, -4) + "0000";
    expect(parseSignedToken(tampered)).toBeNull();
  });

  test("returns null for forged token (valid format, wrong secret)", () => {
    // Manually construct a token with a fake signature
    const forged =
      "exec_stolen-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(parseSignedToken(forged)).toBeNull();
  });

  test("returns null for token with empty executionId", () => {
    expect(parseSignedToken(".abcdef1234567890")).toBeNull();
  });

  test("returns null for token with empty signature", () => {
    expect(parseSignedToken("exec_id.")).toBeNull();
  });

  test("handles executionId containing underscores and hyphens", () => {
    const id = "exec_a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const token = signExecutionToken(id);
    expect(parseSignedToken(token)).toBe(id);
  });
});
