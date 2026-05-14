// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the OAuth2 Resource Owner Password Credentials
 * grant (RFC 6749 §4.3) — issue #400.
 *
 * Covers the three platform-level invariants documented in the password
 * authMode spec:
 *
 *  1. Bootstrap on first use — a fresh connection holds only username +
 *     password; the first `proxyCall` triggers a ROPC token exchange and
 *     persists the resulting tokens.
 *  2. Refresh on 401 — when the upstream rejects a stale access_token,
 *     the proxy calls the token endpoint with `grant_type=refresh_token`
 *     and retries the upstream call once.
 *  3. Re-bootstrap on refresh failure — when the refresh_token is
 *     rejected with `invalid_grant`, the platform falls back to a fresh
 *     ROPC exchange using the stored username/password.
 *
 * The mock OAuth server (`oauth-server.ts`) was extended with per-grant
 * response overrides so a single server instance can replay the whole
 * cycle deterministically.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq, and } from "drizzle-orm";
import { applicationProviderCredentials, userProviderConnections } from "@appstrate/db/schema";
import { decryptCredentials, encryptCredentials } from "@appstrate/connect";

interface DecryptedCredentials {
  access_token?: string;
  refresh_token?: string;
  username?: string;
  password?: string;
  [key: string]: string | undefined;
}
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedPackage, seedConnectionForApp } from "../../helpers/seed.ts";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";
import { createMockOAuthServer, type MockOAuthServer } from "../../helpers/oauth-server.ts";

/**
 * Replace the dummy admin credentials seeded by `seedConnectionForApp`
 * (placeholder ciphertext) with the actual {clientId, clientSecret} the
 * password-grant context needs. Password providers can be public — the
 * helper accepts a partial set.
 */
async function setAdminPasswordCredentials(
  applicationId: string,
  providerId: string,
  creds: { clientId?: string; clientSecret?: string },
): Promise<void> {
  await db
    .update(applicationProviderCredentials)
    .set({ credentialsEncrypted: encryptCredentials(creds) })
    .where(
      and(
        eq(applicationProviderCredentials.applicationId, applicationId),
        eq(applicationProviderCredentials.providerId, providerId),
      ),
    );
}

async function readConnectionCredentials(
  connectionProfileId: string,
  providerId: string,
  orgId: string,
): Promise<DecryptedCredentials> {
  const [row] = await db
    .select({ credentialsEncrypted: userProviderConnections.credentialsEncrypted })
    .from(userProviderConnections)
    .where(
      and(
        eq(userProviderConnections.connectionProfileId, connectionProfileId),
        eq(userProviderConnections.providerId, providerId),
        eq(userProviderConnections.orgId, orgId),
      ),
    )
    .limit(1);
  if (!row) throw new Error("connection not found");
  return decryptCredentials<DecryptedCredentials>(row.credentialsEncrypted);
}

const mockServer: MockOAuthServer = createMockOAuthServer();

afterAll(() => {
  mockServer.stop();
});

describe("password grant (ROPC) — proxyCall integration", () => {
  let ctx: TestContext;
  let connectionProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    mockServer.clearRequests();
    mockServer.clearGrantResponses();
    mockServer.setTokenStatus(200);
    ctx = await createTestContext({ orgSlug: "pwdgrantorg" });
    const profile = await seedConnectionProfile({
      applicationId: ctx.defaultAppId,
      name: "Default",
      isDefault: true,
    });
    connectionProfileId = profile.id;
  });

  async function seedPasswordProvider(providerId: string) {
    await seedPackage({
      orgId: null,
      id: providerId,
      type: "provider",
      source: "system",
      draftManifest: {
        name: providerId,
        version: "1.0.0",
        type: "provider",
        definition: {
          authMode: "password",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://api.example.com/**"],
          password: {
            tokenUrl: `${mockServer.url}/token`,
          },
          credentials: {
            schema: {
              type: "object",
              properties: {
                username: { type: "string" },
                password: { type: "string" },
              },
              required: ["username", "password"],
            },
          },
        },
      },
    });
  }

  it("bootstraps a token on first use and injects it as Bearer", async () => {
    const providerId = "@pwdgrantorg/amisgest";
    await seedPasswordProvider(providerId);

    // Connection stores only username + password — no access_token yet.
    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      username: "alice",
      password: "s3cret",
    });
    await setAdminPasswordCredentials(ctx.defaultAppId, providerId, {});

    mockServer.setGrantResponse("password", {
      status: 200,
      body: {
        access_token: "AT-bootstrap",
        refresh_token: "RT-bootstrap",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });

    const captured: Array<{ authorization: string | null }> = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      captured.push({ authorization: new Headers(init.headers).get("authorization") });
      return Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const res = await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://api.example.com/v1/profile",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.authorization).toBe("Bearer AT-bootstrap");

    // Mock server received exactly one ROPC bootstrap call.
    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(tokenReqs).toHaveLength(1);
    const params = new URLSearchParams(tokenReqs[0]!.body);
    expect(params.get("grant_type")).toBe("password");
    expect(params.get("username")).toBe("alice");
    expect(params.get("password")).toBe("s3cret");

    // Tokens are persisted alongside the stored credentials.
    const persisted = await readConnectionCredentials(connectionProfileId, providerId, ctx.orgId);
    expect(persisted.access_token).toBe("AT-bootstrap");
    expect(persisted.refresh_token).toBe("RT-bootstrap");
    expect(persisted.username).toBe("alice");
    expect(persisted.password).toBe("s3cret");
  });

  it("refreshes the token on 401 and retries the upstream call once", async () => {
    const providerId = "@pwdgrantorg/fizz";
    await seedPasswordProvider(providerId);

    // Pre-loaded with a stale access_token + a valid refresh_token.
    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      username: "bob",
      password: "p4ssw0rd",
      access_token: "AT-stale",
      refresh_token: "RT-valid",
    });
    await setAdminPasswordCredentials(ctx.defaultAppId, providerId, {});

    mockServer.setGrantResponse("refresh_token", {
      status: 200,
      body: {
        access_token: "AT-rotated",
        refresh_token: "RT-rotated",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });

    const captured: Array<{ authorization: string | null }> = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      const auth = new Headers(init.headers).get("authorization");
      captured.push({ authorization: auth });
      const status = captured.length === 1 ? 401 : 200;
      return Promise.resolve(
        new Response(status === 200 ? '{"ok":true}' : "expired", {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const res = await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://api.example.com/v1/me",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.authorization).toBe("Bearer AT-stale");
    expect(captured[1]!.authorization).toBe("Bearer AT-rotated");

    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(tokenReqs).toHaveLength(1);
    const params = new URLSearchParams(tokenReqs[0]!.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("RT-valid");

    const persisted = await readConnectionCredentials(connectionProfileId, providerId, ctx.orgId);
    expect(persisted.access_token).toBe("AT-rotated");
    expect(persisted.refresh_token).toBe("RT-rotated");
  });

  it("re-bootstraps from username/password when the refresh_token is revoked", async () => {
    const providerId = "@pwdgrantorg/amisgest-rebootstrap";
    await seedPasswordProvider(providerId);

    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      username: "carol",
      password: "winter2025",
      access_token: "AT-old",
      refresh_token: "RT-dead",
    });
    await setAdminPasswordCredentials(ctx.defaultAppId, providerId, {});

    // The upstream first rejects the refresh, then accepts a fresh
    // password grant — the platform must transparently re-bootstrap.
    mockServer.setGrantResponse("refresh_token", {
      status: 400,
      body: { error: "invalid_grant" },
    });
    mockServer.setGrantResponse("password", {
      status: 200,
      body: {
        access_token: "AT-fresh",
        refresh_token: "RT-fresh",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });

    const captured: Array<{ authorization: string | null }> = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      const auth = new Headers(init.headers).get("authorization");
      captured.push({ authorization: auth });
      const status = captured.length === 1 ? 401 : 200;
      return Promise.resolve(
        new Response(status === 200 ? '{"ok":true}' : "expired", {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const res = await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://api.example.com/v1/items",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.authorization).toBe("Bearer AT-old");
    expect(captured[1]!.authorization).toBe("Bearer AT-fresh");

    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    // First the refresh attempt, then the re-bootstrap with username/password.
    expect(tokenReqs).toHaveLength(2);
    expect(new URLSearchParams(tokenReqs[0]!.body).get("grant_type")).toBe("refresh_token");
    const second = new URLSearchParams(tokenReqs[1]!.body);
    expect(second.get("grant_type")).toBe("password");
    expect(second.get("username")).toBe("carol");
    expect(second.get("password")).toBe("winter2025");

    const persisted = await readConnectionCredentials(connectionProfileId, providerId, ctx.orgId);
    expect(persisted.access_token).toBe("AT-fresh");
    expect(persisted.refresh_token).toBe("RT-fresh");
  });
});
