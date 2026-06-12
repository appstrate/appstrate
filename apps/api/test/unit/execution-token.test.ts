// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { signRunToken, parseSignedToken } from "../../src/lib/run-token.ts";

// Set a known secret via process.env (no mock.module — compatible with same-process runs)
const originalSecret = process.env.RUN_TOKEN_SECRET;

beforeAll(() => {
  process.env.RUN_TOKEN_SECRET = "test-secret-for-hmac-signing-min32chars!!";
  _resetCacheForTesting();
});

afterAll(() => {
  process.env.RUN_TOKEN_SECRET = originalSecret;
  _resetCacheForTesting();
});

describe("signRunToken", () => {
  it("returns runId.signature format", () => {
    const token = signRunToken("exec_abc-123");
    expect(token).toStartWith("exec_abc-123.");
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[1]!.length).toBe(64); // SHA256 hex = 64 chars
  });

  it("produces deterministic output for same input", () => {
    const a = signRunToken("exec_xyz");
    const b = signRunToken("exec_xyz");
    expect(a).toBe(b);
  });

  it("produces different signatures for different runIds", () => {
    const a = signRunToken("exec_aaa");
    const b = signRunToken("exec_bbb");
    expect(a).not.toBe(b);
  });
});

describe("parseSignedToken", () => {
  it("returns runId for valid signed token", () => {
    const token = signRunToken("exec_test-id");
    const result = parseSignedToken(token);
    expect(result).toBe("exec_test-id");
  });

  it("returns null for unsigned runId (no dot)", () => {
    expect(parseSignedToken("exec_test-id")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSignedToken("")).toBeNull();
  });

  it("returns null for tampered signature", () => {
    const token = signRunToken("exec_real");
    const tampered = token.slice(0, -4) + "0000";
    expect(parseSignedToken(tampered)).toBeNull();
  });

  it("returns null for forged token (valid format, wrong secret)", () => {
    const forged =
      "exec_stolen-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(parseSignedToken(forged)).toBeNull();
  });

  it("returns null for token with empty runId", () => {
    expect(parseSignedToken(".abcdef1234567890")).toBeNull();
  });

  it("returns null for token with empty signature", () => {
    expect(parseSignedToken("exec_id.")).toBeNull();
  });

  it("handles runId containing underscores and hyphens", () => {
    const id = "exec_a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const token = signRunToken(id);
    expect(parseSignedToken(token)).toBe(id);
  });
});

describe("RUN_TOKEN_SECRET keyring rotation", () => {
  const KEY1 = "new-active-key-for-rotation-min32chars!!";
  const KEY2 = "old-retired-key-for-rotation-min32chars!";

  function signWith(key: string, runId: string): string {
    const hasher = new Bun.CryptoHasher("sha256", key);
    hasher.update(runId);
    return `${runId}.${hasher.digest("hex")}`;
  }

  function setSecret(value: string): void {
    process.env.RUN_TOKEN_SECRET = value;
    _resetCacheForTesting();
  }

  afterAll(() => {
    // Restore the single secret the surrounding describes rely on
    process.env.RUN_TOKEN_SECRET = "test-secret-for-hmac-signing-min32chars!!";
    _resetCacheForTesting();
  });

  it("signs with the FIRST key of the keyring", () => {
    setSecret(`${KEY1},${KEY2}`);
    expect(signRunToken("exec_first")).toBe(signWith(KEY1, "exec_first"));
  });

  it("verifies a token signed with a non-first key (in-flight run survives rotation)", () => {
    setSecret(`${KEY1},${KEY2}`);
    const inFlight = signWith(KEY2, "exec_inflight");
    expect(parseSignedToken(inFlight)).toBe("exec_inflight");
  });

  it("verifies a token signed with the first key", () => {
    setSecret(`${KEY1},${KEY2}`);
    expect(parseSignedToken(signWith(KEY1, "exec_active"))).toBe("exec_active");
  });

  it("rejects a token signed with a key removed from the keyring", () => {
    setSecret(KEY1);
    const stale = signWith(KEY2, "exec_stale");
    expect(parseSignedToken(stale)).toBeNull();
  });

  it("single-value secret behaves as a keyring of one (backward compatible)", () => {
    setSecret(KEY1);
    const token = signRunToken("exec_solo");
    expect(token).toBe(signWith(KEY1, "exec_solo"));
    expect(parseSignedToken(token)).toBe("exec_solo");
  });
});
