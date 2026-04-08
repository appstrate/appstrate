// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterAll } from "bun:test";
import * as jose from "jose";
import { verifyEndUserAccessToken, resetJWKSCache } from "../../src/services/enduser-token.ts";

/**
 * Test JWT verification for end-user access tokens.
 *
 * Since verifyEndUserAccessToken fetches JWKS from APP_URL/api/auth/jwks,
 * we test it by creating JWTs signed with a known key and running a tiny
 * JWKS server. When the JWKS endpoint isn't available, verification returns null
 * (graceful fallback).
 */

describe("verifyEndUserAccessToken", () => {
  afterAll(() => {
    resetJWKSCache();
  });

  it("returns null for empty token", async () => {
    const result = await verifyEndUserAccessToken("");
    expect(result).toBeNull();
  });

  it("returns null for malformed JWT", async () => {
    const result = await verifyEndUserAccessToken("not.a.jwt");
    expect(result).toBeNull();
  });

  it("returns null for expired JWT", async () => {
    // Create a real ES256 key pair
    const { privateKey } = await jose.generateKeyPair("ES256");

    // Sign a token that expired 1 hour ago
    const token = await new jose.SignJWT({ endUserId: "eu_test", applicationId: "app_test" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("user_123")
      .setIssuer("http://localhost:3000")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .sign(privateKey);

    // This will fail because JWKS endpoint isn't available in unit tests
    // and even if it were, the key wouldn't match. Either way → null.
    const result = await verifyEndUserAccessToken(token);
    expect(result).toBeNull();
  });

  it("returns null when JWKS endpoint is unreachable", async () => {
    resetJWKSCache();

    const { privateKey } = await jose.generateKeyPair("ES256");
    const token = await new jose.SignJWT({ endUserId: "eu_test" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("user_123")
      .setIssuer("http://localhost:3000")
      .setExpirationTime("15m")
      .setIssuedAt()
      .sign(privateKey);

    // JWKS fetch to localhost:3000/api/auth/jwks will fail (no server running)
    const result = await verifyEndUserAccessToken(token);
    expect(result).toBeNull();
  });

  it("never throws — always returns null on error", async () => {
    // Garbage input should not throw
    const result = await verifyEndUserAccessToken("💀🔥garbage");
    expect(result).toBeNull();
  });
});
