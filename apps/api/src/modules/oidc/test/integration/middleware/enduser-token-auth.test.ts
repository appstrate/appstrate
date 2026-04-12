// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the OIDC module's auth strategy.
 *
 * Spins up a local HTTP JWKS server, points `APP_URL` at it, then boots
 * a test app with the real OIDC module loaded via `getTestApp({ modules })`.
 * The test mints ES256 JWTs by hand against the local JWKS, hits real
 * Appstrate routes, and asserts that:
 *   1. A valid JWT with matching `endUserId`/`applicationId` claims resolves
 *      through the strategy, populates `endUser` in request context, and
 *      reaches the route handler (200 response).
 *   2. An unknown `endUserId` claim → strategy returns null → falls through
 *      to core auth (401 without other credentials).
 *   3. A malformed `Bearer ey...` (valid structure, invalid signature) →
 *      null → falls through to core auth.
 *   4. An `Authorization: Bearer ask_...` header does NOT match this
 *      strategy (fast no-match path) so core API-key auth keeps working.
 *
 * This is the Stage 3 smoke test proving the full wiring chain:
 *     module → authStrategies() → test-app middleware → AuthResolution →
 *     c.set(endUser) → strict run-filter path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { eq } from "drizzle-orm";
import { _resetCacheForTesting } from "@appstrate/env";
import { db } from "@appstrate/db/client";
import { endUsers, applications } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import { oidcEndUserProfiles } from "../../../schema.ts";
import { prefixedId } from "../../../../../lib/ids.ts";

// NOTE: env + JWKS server must be set BEFORE importing anything that
// touches `getEnv()` cache or the OIDC module. The module itself is
// imported lazily inside beforeAll so `getTestApp()` sees the final
// APP_URL value.
const originalAppUrl = process.env.APP_URL;
let jwksServer: ReturnType<typeof Bun.serve> | null = null;
let privateKey: jose.CryptoKey;
let kid: string;
let publicJwk: jose.JWK;
let app: Awaited<ReturnType<typeof import("../../../../../../test/helpers/app.ts").getTestApp>>;

async function startJwksServer() {
  const { publicKey, privateKey: priv } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });
  privateKey = priv;
  const jwk = await jose.exportJWK(publicKey);
  kid = "oidc-test-key-1";
  jwk.kid = kid;
  jwk.alg = "ES256";
  jwk.use = "sig";
  publicJwk = jwk;

  jwksServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/jwks") {
        return Response.json({ keys: [jwk] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.APP_URL = `http://127.0.0.1:${jwksServer.port}`;
  _resetCacheForTesting();
}

async function mintToken(payload: Record<string, unknown>) {
  // Real Better Auth tokens carry `iss = ${APP_URL}${basePath}` where
  // basePath is `/api/auth`. The production verifier in `enduser-token.ts`
  // matches against that shape; the test harness must mint tokens with the
  // same `iss` claim or it will exercise the wrong code path. Audience must
  // also be in `validAudiences` (APP_URL or APP_URL/api/auth) — C1 added
  // explicit `aud` verification for defense-in-depth.
  const issuer = `${process.env.APP_URL!}/api/auth`;
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(issuer)
    .setAudience(process.env.APP_URL!)
    .setIssuedAt()
    .setExpirationTime("2m")
    .setSubject(typeof payload.sub === "string" ? payload.sub : "auth_user_stage3")
    .sign(privateKey);
}

beforeAll(async () => {
  await startJwksServer();
  const { getTestApp } = await import("../../../../../../test/helpers/app.ts");
  const { default: oidcModule } = await import("../../../index.ts");
  // Install an in-process JWKS resolver built from the test public key.
  // This bypasses both the `auth.api.getJwks()` path (which would resolve
  // against the Better Auth singleton the preload built with a different
  // key set) and the remote URL path (which would need a real HTTP
  // listener on APP_URL). Tokens minted by `mintToken()` below verify
  // cleanly against this resolver.
  const { overrideJwksResolver } = await import("../../../services/enduser-token.ts");
  const localSet = jose.createLocalJWKSet({ keys: [publicJwk] });
  overrideJwksResolver(localSet as unknown as Parameters<typeof overrideJwksResolver>[0]);
  app = getTestApp({ modules: [oidcModule] });
});

afterAll(() => {
  jwksServer?.stop(true);
  if (originalAppUrl === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = originalAppUrl;
  }
  _resetCacheForTesting();
});

describe("OIDC auth strategy — end-to-end via getTestApp", () => {
  let orgId: string;
  let applicationId: string;
  let authUserId: string;
  let endUserId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id: ownerId } = await createTestUser();
    const { org, defaultAppId } = await createTestOrg(ownerId, { slug: "oidcstrat" });
    orgId = org.id;
    applicationId = defaultAppId;

    // End-user auth identity (distinct from the owning member).
    const { id } = await createTestUser({
      email: "stage3@example.com",
      name: "Stage Three",
    });
    authUserId = id;

    endUserId = prefixedId("eu");
    await db.insert(endUsers).values({
      id: endUserId,
      applicationId,
      orgId,
      email: "stage3@example.com",
      name: "Stage Three",
    });
    await db.insert(oidcEndUserProfiles).values({
      endUserId,
      authUserId,
      emailVerified: true,
      status: "active",
    });
  });

  it("resolves a valid JWT to endUser context and reaches the route", async () => {
    const token = await mintToken({
      sub: authUserId,
      actor_type: "end_user",
      end_user_id: endUserId,
      application_id: applicationId,
      email: "stage3@example.com",
      name: "Stage Three",
      scope: "openid runs:read",
    });
    const res = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-App-Id": applicationId,
      },
    });
    // Strategy claimed the request, endUser context set, route reached.
    expect(res.status).toBe(200);
  });

  it("falls through when the end-user claim is unknown", async () => {
    const token = await mintToken({
      sub: authUserId,
      actor_type: "end_user",
      end_user_id: "eu_does_not_exist",
      application_id: applicationId,
    });
    const res = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-App-Id": applicationId,
      },
    });
    // Strategy returned null → fell through to core auth → no session → 401.
    expect(res.status).toBe(401);
  });

  it("falls through when the JWT signature is invalid", async () => {
    const res = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.bogus.signature",
        "X-App-Id": applicationId,
      },
    });
    expect(res.status).toBe(401);
  });

  it("ignores `Bearer ask_...` (API key) — fast no-match path", async () => {
    // The strategy must not shadow core API-key auth. An invalid ask_ key
    // should reach core's API-key path and come back as 401 from there,
    // not as a JWT verification error.
    const res = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: "Bearer ask_invalid_key_000000000000000000000000",
        "X-App-Id": applicationId,
      },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a spoofed X-App-Id header when the JWT pinned a different application", async () => {
    // A1 — cross-application escalation guard. Holder of a valid JWT for
    // App A must not be able to reach App B (same org) by attaching a
    // spoofed `X-App-Id: App B` header. `requireAppContext()` pins
    // applicationId from the auth strategy first and rejects any header
    // that contradicts the pinned value.
    const { id: otherOwnerId } = await createTestUser();
    const { defaultAppId: otherAppId } = await createTestOrg(otherOwnerId, {
      slug: "escalateapp",
    });
    expect(otherAppId).not.toBe(applicationId);

    const token = await mintToken({
      sub: authUserId,
      actor_type: "end_user",
      end_user_id: endUserId,
      application_id: applicationId, // JWT legitimately scoped to App A
    });
    const res = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-App-Id": otherAppId, // spoof attempt: App B
      },
    });
    expect(res.status).toBe(403);
  });

  it("accepts a matching X-App-Id header when the JWT already pinned the application", async () => {
    // Regression guard for A1: the common case (satellite sends both
    // Authorization and X-App-Id with matching values) must still reach
    // the route handler.
    const token = await mintToken({
      sub: authUserId,
      actor_type: "end_user",
      end_user_id: endUserId,
      application_id: applicationId,
    });
    const res = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-App-Id": applicationId,
      },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a token whose claim applicationId mismatches the end-user row", async () => {
    // Create a second app in the same org.
    const { id: otherOwnerId } = await createTestUser();
    const { defaultAppId: otherAppId } = await createTestOrg(otherOwnerId, {
      slug: "otherapp",
    });
    expect(otherAppId).not.toBe(applicationId);

    // Sanity: the end-user still belongs to the first app.
    const [row] = await db
      .select({ appId: endUsers.applicationId })
      .from(endUsers)
      .where(eq(endUsers.id, endUserId));
    expect(row!.appId).toBe(applicationId);

    // Token claims the end-user lives in otherApp — strategy should refuse.
    const token = await mintToken({
      sub: authUserId,
      actor_type: "end_user",
      end_user_id: endUserId,
      application_id: otherAppId,
    });
    const res = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-App-Id": otherAppId,
      },
    });
    // Strategy returned null (mismatch) → fell through → 401.
    expect(res.status).toBe(401);

    // Silence unused-import warnings — applications import is retained for
    // anyone extending the test to cross-check app metadata.
    void applications;
  });

  it("rejects a token when the end-user is suspended", async () => {
    // Mark end-user as suspended in the OIDC profile.
    await db
      .update(oidcEndUserProfiles)
      .set({ status: "suspended" })
      .where(eq(oidcEndUserProfiles.endUserId, endUserId));

    const token = await mintToken({
      sub: authUserId,
      actor_type: "end_user",
      end_user_id: endUserId,
      application_id: applicationId,
      email: "stage3@example.com",
    });
    const res = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-App-Id": applicationId,
      },
    });
    // Strategy returns null for non-active end-user → falls through → 401.
    expect(res.status).toBe(401);
  });

  it("rejects a token from a disabled OAuth client (via azp claim)", async () => {
    // Create a real OAuth client, then disable it. Tokens carrying its
    // client_id in the azp claim must be rejected by the strategy.
    const { createClient, updateClient } = await import("../../../services/oauth-admin.ts");

    const client = await createClient({
      level: "application",
      name: "Disabled Test Client",
      redirectUris: ["https://example.com/cb"],
      referencedApplicationId: applicationId,
    });

    // Mint a token with the azp claim matching the client.
    const token = await mintToken({
      sub: authUserId,
      azp: client.clientId,
      actor_type: "end_user",
      end_user_id: endUserId,
      application_id: applicationId,
    });

    // Token should work while client is active.
    const goodRes = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-App-Id": applicationId,
      },
    });
    expect(goodRes.status).toBe(200);

    // Disable the client.
    await updateClient(client.clientId, { disabled: true });

    // Same token should now be rejected.
    const badRes = await app.request(`/api/end-users/${endUserId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-App-Id": applicationId,
      },
    });
    expect(badRes.status).toBe(401);
  });

  it("resolves a dashboard_user token to a dashboard session (no endUser)", async () => {
    // Dashboard tokens carry actor_type: "dashboard_user" with org_id +
    // org_role. The strategy resolves them to a normal admin session, NOT
    // an end-user session.
    const { organizationMembers } = await import("@appstrate/db/schema");

    // The authUserId created in beforeEach is not an org member — we need
    // to add them to the org for the dashboard strategy to resolve.
    await db.insert(organizationMembers).values({
      userId: authUserId,
      orgId,
      role: "admin",
    });

    const token = await mintToken({
      sub: authUserId,
      actor_type: "dashboard_user",
      org_id: orgId,
      org_role: "admin",
      email: "stage3@example.com",
      name: "Stage Three",
      scope: "openid",
    });

    // Hit an org-scoped route (not app-scoped). Profile route works for any
    // authenticated user.
    const res = await app.request("/api/profile", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a dashboard_user token when user is no longer an org member", async () => {
    // Token was minted when user was a member, but membership was revoked.
    // The strategy re-verifies membership from the DB and rejects.
    const token = await mintToken({
      sub: authUserId,
      actor_type: "dashboard_user",
      org_id: orgId,
      org_role: "admin",
      email: "stage3@example.com",
    });

    // authUserId is NOT a member of orgId (no membership row inserted).
    const res = await app.request("/api/profile", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // Strategy returns null (membership check fails) → 401.
    expect(res.status).toBe(401);
  });
});
