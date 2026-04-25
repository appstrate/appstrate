// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the `deferOrgResolution` flag.
 *
 * Verifies that when a module strategy sets `deferOrgResolution: true`,
 * the auth pipeline defers org resolution to the X-Org-Id middleware
 * (same path as session auth) and derives permissions from orgRole
 * after org-context resolves.
 *
 * Uses the OIDC instance token flow as the real-world test case.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { _resetCacheForTesting } from "@appstrate/env";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";

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
  kid = "defer-org-test-key-1";
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

async function mintInstanceToken(
  sub: string,
  clientId: string,
  overrides: Record<string, unknown> = {},
) {
  const issuer = `${process.env.APP_URL!}/api/auth`;
  return new jose.SignJWT({
    azp: clientId,
    actor_type: "user",
    email: "defer@example.com",
    name: "Defer Test User",
    scope: "openid profile email",
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(issuer)
    .setAudience(process.env.APP_URL!)
    .setIssuedAt()
    .setExpirationTime("2m")
    .setSubject(sub)
    .sign(privateKey);
}

beforeAll(async () => {
  await startJwksServer();
  const { getTestApp } = await import("../../../../../../test/helpers/app.ts");
  const { default: oidcModule } = await import("../../../index.ts");
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

describe("deferOrgResolution in auth pipeline", () => {
  let authUserId: string;
  let orgId: string;
  let defaultAppId: string;
  let instanceClientId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id: ownerId } = await createTestUser();
    const { org, defaultAppId: appId } = await createTestOrg(ownerId, { slug: "deferorg" });
    orgId = org.id;
    authUserId = ownerId;
    defaultAppId = appId;

    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    instanceClientId = await ensureInstanceClient("http://localhost:3000");
  });

  it("defers org resolution — instance token + X-Org-Id resolves org context", async () => {
    const token = await mintInstanceToken(authUserId, instanceClientId);

    // Hit an app-scoped route with X-Org-Id + X-App-Id.
    // If deferOrgResolution works, the pipeline will resolve org via X-Org-Id
    // header (same as session auth) instead of requiring inline org context.
    const res = await app.request("/api/agents", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": orgId,
        "X-App-Id": defaultAppId,
      },
    });
    // 200 means: auth passed, org resolved via X-Org-Id, permissions derived from orgRole
    expect(res.status).toBe(200);
  });

  it("defers org resolution — instance token without X-Org-Id can access user-scoped routes", async () => {
    const token = await mintInstanceToken(authUserId, instanceClientId);

    // User-scoped route (no org context needed)
    const res = await app.request("/api/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("defers org resolution — instance token with wrong X-Org-Id returns 403/404", async () => {
    // Create a second org that the user is NOT a member of
    const { id: otherOwnerId } = await createTestUser({ email: "other@test.com" });
    const { org: otherOrg } = await createTestOrg(otherOwnerId, { slug: "otherorg" });

    const token = await mintInstanceToken(authUserId, instanceClientId);

    const res = await app.request("/api/agents", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": otherOrg.id,
        "X-App-Id": "app_fake",
      },
    });
    // Not a member → org context middleware rejects
    expect([403, 404]).toContain(res.status);
  });

  it("derives permissions from orgRole — instance token can perform admin actions", async () => {
    const token = await mintInstanceToken(authUserId, instanceClientId);

    // The test user is the org owner. The pipeline should derive owner
    // permissions from orgRole after X-Org-Id resolution.
    const res = await app.request("/api/applications", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": orgId,
      },
    });
    // Admin-only route — should succeed since user is owner
    expect(res.status).toBe(200);
  });

  it("resolveInstanceUser returns deferOrgResolution: true", async () => {
    // Directly test the strategy function's return shape
    const { oidcAuthStrategy } = await import("../../../auth/strategy.ts");

    const token = await mintInstanceToken(authUserId, instanceClientId);

    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const resolution = await oidcAuthStrategy.authenticate({
      headers,
      method: "GET",
      path: "/api/profile",
      request: new Request("http://localhost/api/profile", { headers }),
    });

    expect(resolution).not.toBeNull();
    expect(resolution!.deferOrgResolution).toBe(true);
    expect(resolution!.authMethod).toBe("oauth2-instance");
    expect(resolution!.permissions).toEqual([]);
    // No org context on instance resolution
    expect(resolution!.orgId).toBeUndefined();
    expect(resolution!.orgRole).toBeUndefined();
  });
});
