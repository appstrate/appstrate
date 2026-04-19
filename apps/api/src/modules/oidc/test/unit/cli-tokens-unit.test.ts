// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-unit tests for `services/cli-tokens.ts` — the parts that have no
 * DB dependency and can be verified without spinning up the Better Auth
 * singleton.
 */

import { describe, it, expect } from "bun:test";
import {
  CliTokenError,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  _hashRefreshTokenForTesting,
  _generateRefreshTokenForTesting,
  _narrowScopeToClientForTesting,
} from "../../services/cli-tokens.ts";

describe("CliTokenError", () => {
  it("carries the OAuth2 error code + description and extends Error", () => {
    const err = new CliTokenError("invalid_grant", "Refresh token reuse detected.");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CliTokenError");
    expect(err.code).toBe("invalid_grant");
    expect(err.description).toBe("Refresh token reuse detected.");
    expect(err.message).toBe("Refresh token reuse detected.");
  });

  it("accepts every RFC 6749 / RFC 8628 error code this module can produce", () => {
    // Coverage contract: the error-code union drives `cli-plugin.ts`'s
    // `httpStatusFor`. A new code added to the union must come with a
    // matching status mapping — checking the constructor accepts them
    // all guards against a typo-only drift.
    const codes: Array<
      | "authorization_pending"
      | "slow_down"
      | "expired_token"
      | "access_denied"
      | "invalid_request"
      | "invalid_grant"
      | "invalid_client"
      | "server_error"
    > = [
      "authorization_pending",
      "slow_down",
      "expired_token",
      "access_denied",
      "invalid_request",
      "invalid_grant",
      "invalid_client",
      "server_error",
    ];
    for (const c of codes) {
      const err = new CliTokenError(c, "msg");
      expect(err.code).toBe(c);
    }
  });
});

describe("TTL constants (issue #165)", () => {
  it("issues 15 min access tokens", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
  });

  it("issues 30 day refresh tokens", () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe("refresh token generation + hashing (test helpers)", () => {
  it("generates 32 bytes of CSPRNG as base64url (43 chars, no padding)", () => {
    const tok = _generateRefreshTokenForTesting();
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/); // base64url charset
    expect(tok).not.toContain("="); // no padding
    expect(tok.length).toBe(43); // 32 bytes → 43 base64url chars
  });

  it("distinct tokens across calls (no repeats within a batch of 1k)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(_generateRefreshTokenForTesting());
    expect(set.size).toBe(1000);
  });

  it("hashes tokens deterministically via SHA-256 hex (64 chars)", () => {
    const hash1 = _hashRefreshTokenForTesting("abc");
    const hash2 = _hashRefreshTokenForTesting("abc");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different inputs", () => {
    const hashA = _hashRefreshTokenForTesting("token-a");
    const hashB = _hashRefreshTokenForTesting("token-b");
    expect(hashA).not.toBe(hashB);
  });
});

describe("narrowScopeToClient (PR #191 review — defense-in-depth scope gate)", () => {
  const ctx = { clientId: "appstrate-cli", userId: "u_1" };

  it("returns empty string when requested is empty", () => {
    expect(_narrowScopeToClientForTesting("", ["openid", "profile"], ctx)).toBe("");
    expect(_narrowScopeToClientForTesting("   ", ["openid"], ctx)).toBe("");
  });

  it("drops ALL scopes when client declares no scopes (fail-closed)", () => {
    expect(_narrowScopeToClientForTesting("openid profile", null, ctx)).toBe("");
    expect(_narrowScopeToClientForTesting("openid profile", [], ctx)).toBe("");
  });

  it("preserves scopes that appear in the client's declared set", () => {
    expect(
      _narrowScopeToClientForTesting(
        "openid profile email offline_access",
        ["openid", "profile", "email", "offline_access"],
        ctx,
      ),
    ).toBe("openid profile email offline_access");
  });

  it("drops unknown scopes while keeping the allowed ones in request order", () => {
    expect(
      _narrowScopeToClientForTesting(
        "openid admin:* profile evil",
        ["openid", "profile", "email"],
        ctx,
      ),
    ).toBe("openid profile");
  });

  it("deduplicates repeated tokens", () => {
    expect(
      _narrowScopeToClientForTesting("openid openid profile openid", ["openid", "profile"], ctx),
    ).toBe("openid profile");
  });

  it("returns empty string when every requested scope is disallowed", () => {
    expect(_narrowScopeToClientForTesting("admin:* root", ["openid"], ctx)).toBe("");
  });
});
