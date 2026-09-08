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
import type { JwksFetch } from "../../services/enduser-token.ts";

// NOTE: must set env BEFORE importing the service (getEnv caches).
// We pick an ephemeral port below and rewrite APP_URL to match.
const originalAppUrl = process.env.APP_URL;
let server: ReturnType<typeof Bun.serve> | null = null;
let privateKey: jose.CryptoKey;
let kid: string;
let publicJwk: jose.JWK;
let localJwks: JwksFetch;

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
  localJwks = async () => ({ keys: [publicJwk] });
}

async function mintToken(payload: Record<string, unknown>, audience?: string) {
  const env = process.env.APP_URL ?? "http://127.0.0.1";
  // Default to the platform APP_URL — one of `getEndUserVerifyAudiences()`
  // (`lib/audiences.ts`), which the production verifier enforces as `aud`.
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
      actor_type: "end_user",
      end_user_id: "eu_abc",
      space_id: "spc_xyz",
      email: "user@example.com",
      name: "User One",
      scope: "openid runs:read",
    });
    const claims = await verifyEndUserAccessToken(token, { jwks: localJwks });
    expect(claims).not.toBeNull();
    expect(claims!.authUserId).toBe("auth_user_1");
    expect(claims!.actorType).toBe("end_user");
    expect(claims!.endUserId).toBe("eu_abc");
    expect(claims!.spaceId).toBe("spc_xyz");
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

  // C1 — audience must be one of `getEndUserVerifyAudiences()`.
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
    const token = await mintToken(
      { sub: "auth_user_1", actor_type: "end_user", end_user_id: "eu_abc" },
      `${env}/api/auth`,
    );
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

  // The two cache properties the verifier inherits from `verifyJwsAccessToken`,
  // asserted through the module source (`overrideJwks`) — `deps.jwks` is
  // deliberately uncached, so it cannot show either.
  it("reads the key set once for two verifies inside the cache TTL", async () => {
    const { verifyEndUserAccessToken, overrideJwks } =
      await import("../../services/enduser-token.ts");
    let reads = 0;
    overrideJwks(async () => {
      reads += 1;
      return { keys: [publicJwk] };
    });
    try {
      expect(
        await verifyEndUserAccessToken(await mintToken({ sub: "auth_user_1" })),
      ).not.toBeNull();
      expect(reads).toBe(1);
      expect(
        await verifyEndUserAccessToken(await mintToken({ sub: "auth_user_2" })),
      ).not.toBeNull();
      expect(reads).toBe(1);
    } finally {
      overrideJwks(null);
    }
  });

  it("re-reads the key set exactly once for an unknown kid, then refuses the token", async () => {
    const { verifyEndUserAccessToken, overrideJwks } =
      await import("../../services/enduser-token.ts");
    let reads = 0;
    overrideJwks(async () => {
      reads += 1;
      return { keys: [publicJwk] };
    });
    try {
      expect(
        await verifyEndUserAccessToken(await mintToken({ sub: "auth_user_1" })),
      ).not.toBeNull();
      expect(reads).toBe(1);
      // Signed by a key the served set never carries — what a client presenting
      // a token from the far side of a rotation looks like.
      const { privateKey: rotated } = await jose.generateKeyPair("ES256", { extractable: true });
      const rotatedToken = await new jose.SignJWT({ sub: "auth_user_1" })
        .setProtectedHeader({ alg: "ES256", kid: "rotated-key" })
        .setIssuer(`${process.env.APP_URL!}/api/auth`)
        .setAudience(process.env.APP_URL!)
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(rotated);
      expect(await verifyEndUserAccessToken(rotatedToken)).toBeNull();
      expect(reads).toBe(2);
    } finally {
      overrideJwks(null);
    }
  });
});
