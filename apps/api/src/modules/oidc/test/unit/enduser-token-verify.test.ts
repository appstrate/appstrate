// SPDX-License-Identifier: Apache-2.0

/**
 * End-user token verify — unit test.
 *
 * These tests do not use a real Better Auth JWKS endpoint; instead they spin
 * up an in-process HTTP server that serves a single-key JWKS and mint tokens
 * with `jose` against that same key. The service reads `APP_URL` at first
 * `verifyEndUserAccessToken` call, so we point it at `http://127.0.0.1:<port>`
 * before importing anything.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as jose from "jose";
import { _resetCacheForTesting } from "@appstrate/env";
import type { JwksResolver } from "../../services/enduser-token.ts";

// NOTE: must set env BEFORE importing the service (getEnv caches).
// We pick an ephemeral port below and rewrite APP_URL to match.
const originalAppUrl = process.env.APP_URL;
let server: ReturnType<typeof Bun.serve> | null = null;
let privateKey: jose.CryptoKey;
let kid: string;
let publicJwk: jose.JWK;
let localJwks: JwksResolver;

async function startJwksServer() {
  const { publicKey, privateKey: priv } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });
  privateKey = priv;
  const jwk = await jose.exportJWK(publicKey);
  kid = "test-key-1";
  jwk.kid = kid;
  jwk.alg = "ES256";
  jwk.use = "sig";
  publicJwk = jwk;

  server = Bun.serve({
    port: 0, // ephemeral
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/jwks") {
        return Response.json({ keys: [jwk] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.APP_URL = `http://127.0.0.1:${server.port}`;
  _resetCacheForTesting();
  localJwks = jose.createLocalJWKSet({ keys: [publicJwk] }) as unknown as JwksResolver;
}

async function mintToken(payload: Record<string, unknown>, audience?: string) {
  const env = process.env.APP_URL ?? "http://127.0.0.1";
  // Default to the platform APP_URL which matches `validAudiences` in
  // `auth/plugins.ts` — the production verifier now enforces `aud`.
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(`${env}/api/auth`)
    .setAudience(audience ?? env)
    .setIssuedAt()
    .setExpirationTime("2m")
    .setSubject(typeof payload.sub === "string" ? payload.sub : "auth_user_1")
    .sign(privateKey);
}

beforeAll(async () => {
  await startJwksServer();
});

afterAll(() => {
  server?.stop(true);
  if (originalAppUrl === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = originalAppUrl;
  }
  _resetCacheForTesting();
});

describe("verifyEndUserAccessToken", () => {
  it("returns claims for a valid ES256 token", async () => {
    const { verifyEndUserAccessToken } = await import("../../services/enduser-token.ts");
    const token = await mintToken({
      sub: "auth_user_1",
      endUserId: "eu_abc",
      applicationId: "app_xyz",
      email: "user@example.com",
      name: "User One",
      scope: "openid runs:read",
    });
    const claims = await verifyEndUserAccessToken(token, { jwks: localJwks });
    expect(claims).not.toBeNull();
    expect(claims!.authUserId).toBe("auth_user_1");
    expect(claims!.endUserId).toBe("eu_abc");
    expect(claims!.applicationId).toBe("app_xyz");
    expect(claims!.email).toBe("user@example.com");
    expect(claims!.scope).toBe("openid runs:read");
  });

  it("returns null for a malformed token", async () => {
    const { verifyEndUserAccessToken } = await import("../../services/enduser-token.ts");
    expect(await verifyEndUserAccessToken("not-a-jwt", { jwks: localJwks })).toBeNull();
    expect(await verifyEndUserAccessToken("ey.foo.bar", { jwks: localJwks })).toBeNull();
  });

  it("returns null for a token signed by the wrong key", async () => {
    const { verifyEndUserAccessToken } = await import("../../services/enduser-token.ts");
    const { privateKey: rogue } = await jose.generateKeyPair("ES256", { extractable: true });
    const rogueToken = await new jose.SignJWT({ sub: "auth_user_1" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(`${process.env.APP_URL!}/api/auth`)
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(rogue);
    expect(await verifyEndUserAccessToken(rogueToken, { jwks: localJwks })).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const { verifyEndUserAccessToken } = await import("../../services/enduser-token.ts");
    const expired = await new jose.SignJWT({ sub: "auth_user_1" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(`${process.env.APP_URL!}/api/auth`)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);
    expect(await verifyEndUserAccessToken(expired, { jwks: localJwks })).toBeNull();
  });

  // C1 — audience must match `validAudiences` from `auth/plugins.ts`.
  // Before the fix the verifier only checked `iss`, so a token minted for a
  // different audience (e.g. a rogue plugin update) would slip through.
  it("returns null when the audience does not match APP_URL", async () => {
    const { verifyEndUserAccessToken } = await import("../../services/enduser-token.ts");
    const wrongAud = await mintToken({ sub: "auth_user_1" }, "https://evil.example.com");
    expect(await verifyEndUserAccessToken(wrongAud, { jwks: localJwks })).toBeNull();
  });

  it("returns claims when the audience matches APP_URL/api/auth", async () => {
    // Second accepted audience in the allowlist — satellites can pass either
    // the issuer or the Better Auth base URL as their `resource` parameter.
    const { verifyEndUserAccessToken } = await import("../../services/enduser-token.ts");
    const env = process.env.APP_URL!;
    const token = await mintToken({ sub: "auth_user_1", endUserId: "eu_abc" }, `${env}/api/auth`);
    const claims = await verifyEndUserAccessToken(token, { jwks: localJwks });
    expect(claims).not.toBeNull();
    expect(claims!.endUserId).toBe("eu_abc");
  });

  it("returns null when the issuer does not match APP_URL", async () => {
    const { verifyEndUserAccessToken } = await import("../../services/enduser-token.ts");
    const bad = await new jose.SignJWT({ sub: "auth_user_1" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer("https://evil.example.com")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);
    expect(await verifyEndUserAccessToken(bad, { jwks: localJwks })).toBeNull();
  });

  it("returns null when the sub claim is missing", async () => {
    const { verifyEndUserAccessToken } = await import("../../services/enduser-token.ts");
    const noSub = await new jose.SignJWT({ endUserId: "eu_foo" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(`${process.env.APP_URL!}/api/auth`)
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);
    expect(await verifyEndUserAccessToken(noSub, { jwks: localJwks })).toBeNull();
  });
});
