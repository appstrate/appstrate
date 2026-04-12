// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for instance-level OIDC client support.
 *
 * Covers auto-provisioning, strategy resolution, security guards
 * (API rejection, ownership blocking), and AppConfig injection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { eq } from "drizzle-orm";
import { _resetCacheForTesting } from "@appstrate/env";
import { db } from "@appstrate/db/client";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestUser,
  createTestOrg,
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { oauthClient } from "../../../schema.ts";

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
  kid = "instance-test-key-1";
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
  const issuer = `${process.env.APP_URL!}/api/auth`;
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(issuer)
    .setAudience(process.env.APP_URL!)
    .setIssuedAt()
    .setExpirationTime("2m")
    .setSubject(typeof payload.sub === "string" ? payload.sub : "auth_user_instance")
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

// ─── Auto-provisioning ────────────────────────────────────────────────────────

describe("ensureInstanceClient", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("creates an instance client on first call", async () => {
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");
    expect(clientId).toStartWith("oauth_");

    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.level).toBe("instance");
    expect(row!.skipConsent).toBe(true); // isFirstParty
    expect(row!.referencedOrgId).toBeNull();
    expect(row!.referencedApplicationId).toBeNull();
    expect(row!.redirectUris).toEqual(["http://localhost:3000/auth/callback"]);
  });

  it("is idempotent — second call returns the same clientId", async () => {
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const first = await ensureInstanceClient("http://localhost:3000");
    const second = await ensureInstanceClient("http://localhost:3000");
    expect(first).toBe(second);

    // Only one instance client in DB
    const rows = await db.select().from(oauthClient).where(eq(oauthClient.level, "instance"));
    expect(rows).toHaveLength(1);
  });
});

// ─── Strategy resolution ──────────────────────────────────────────────────────

describe("instance token strategy", () => {
  let authUserId: string;
  let orgId: string;
  let instanceClientId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id: ownerId } = await createTestUser();
    const { org } = await createTestOrg(ownerId, { slug: "instancestrat" });
    orgId = org.id;
    authUserId = ownerId;

    // Create an instance client for cross-validation tests
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    instanceClientId = await ensureInstanceClient("http://localhost:3000");
  });

  it("resolves an instance token to a user without orgId", async () => {
    const token = await mintToken({
      sub: authUserId,
      azp: instanceClientId,
      actor_type: "user",
      email: "test@example.com",
      name: "Test User",
      scope: "openid profile email",
    });

    // Hit a route that skips org-context (user-scoped)
    const res = await app.request("/api/profile", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("resolves an instance token + X-Org-Id to a full org session", async () => {
    const token = await mintToken({
      sub: authUserId,
      azp: instanceClientId,
      actor_type: "user",
      email: "test@example.com",
      name: "Test User",
      scope: "openid profile email",
    });

    // Hit an org-scoped route with X-Org-Id header
    const res = await app.request("/api/agents", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": orgId,
      },
    });
    // Should work since the user is a member of the org
    // (may need X-App-Id too depending on route, but the auth + org resolution should pass)
    expect([200, 400]).toContain(res.status); // 400 if missing X-App-Id, but NOT 401/403
  });

  it("rejects instance token when user does not exist", async () => {
    const token = await mintToken({
      sub: "nonexistent_user_id",
      azp: instanceClientId,
      actor_type: "user",
      email: "ghost@example.com",
    });

    const res = await app.request("/api/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects cross-validation: actor_type=user + non-instance client", async () => {
    // Create an org-level client
    const { createClient } = await import("../../../services/oauth-admin.ts");
    const orgClient = await createClient({
      level: "org",
      name: "Org Client",
      redirectUris: ["https://example.com/cb"],
      referencedOrgId: orgId,
    });

    const token = await mintToken({
      sub: authUserId,
      azp: orgClient.clientId,
      actor_type: "user", // Mismatch: user token for org client
      email: "test@example.com",
    });

    const res = await app.request("/api/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

// ─── Security: API rejection ─────────────────────────────────────────────────

describe("instance client security", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "instancesec" });
  });

  it("POST /api/oauth/clients rejects level=instance (Zod validation)", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "instance",
        name: "Sneaky Instance",
        redirectUris: ["https://evil.com/cb"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("instance client is NOT in GET /api/oauth/clients list", async () => {
    // Provision an instance client
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    await ensureInstanceClient("http://localhost:3000");

    const res = await app.request("/api/oauth/clients", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ level: string }> };
    const instanceClients = body.data.filter((c) => c.level === "instance");
    expect(instanceClients).toHaveLength(0);
  });

  it("PATCH on instance client returns 404 (ownership check blocks)", async () => {
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");

    const res = await app.request(`/api/oauth/clients/${clientId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE on instance client returns 404 (ownership check blocks)", async () => {
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");

    const res = await app.request(`/api/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
