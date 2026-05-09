// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the 401-refresh-retry path in the public
 * credential-proxy core (issue #332).
 *
 * Pre-fix: `proxyCall()` only refreshed credentials on 401 when the body
 * was a `ReadableStream` — buffered bodies (the typical CLI / GitHub
 * Action GET) had the upstream 401 forwarded as-is, so any expired
 * OAuth `access_token` made every remote run fail silently while the
 * sidecar (Docker runs) refreshed and retried correctly.
 *
 * Post-fix: buffered bodies trigger a `forceRefreshCredentials` call,
 * the rotated credential header is re-injected, and the upstream call
 * is replayed exactly once. Streaming bodies keep their existing
 * `authRefreshed: true` escape-hatch (cannot be replayed server-side).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedPackage, seedConnectionForApp } from "../../helpers/seed.ts";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";
import { createMockOAuthServer, type MockOAuthServer } from "../../helpers/oauth-server.ts";
import { applicationProviderCredentials } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import { eq, and } from "drizzle-orm";

/**
 * Replace the dummy admin credentials seeded by `seedConnectionForApp`
 * with real encrypted clientId/clientSecret so OAuth2 refresh can run.
 */
async function setAdminOAuthCredentials(
  applicationId: string,
  providerId: string,
  creds: { clientId: string; clientSecret: string },
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

const mockServer: MockOAuthServer = createMockOAuthServer();

afterAll(() => {
  mockServer.stop();
});

describe("proxyCall — 401 refresh-retry on buffered bodies", () => {
  let ctx: TestContext;
  let connectionProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    mockServer.clearRequests();
    mockServer.setTokenStatus(200);
    ctx = await createTestContext({ orgSlug: "cprefreshorg" });
    const profile = await seedConnectionProfile({
      applicationId: ctx.defaultAppId,
      name: "Default",
      isDefault: true,
    });
    connectionProfileId = profile.id;
  });

  it("refreshes the OAuth2 token and retries the call when upstream returns 401", async () => {
    const providerId = "@cprefreshorg/gmail";
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
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          oauth2: {
            authorizationUrl: `${mockServer.url}/authorize`,
            tokenUrl: `${mockServer.url}/token`,
          },
        },
      },
    });

    // Seed an end-user connection holding an EXPIRED access_token + a
    // refresh_token the mock server will accept. `seedConnectionForApp`
    // creates the admin credentials row with a dummy ciphertext — replace
    // it with real clientId/clientSecret so the OAuth2 refresh path can
    // build its RefreshContext.
    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      access_token: "stale_token",
      refresh_token: "rt_valid",
    });
    await setAdminOAuthCredentials(ctx.defaultAppId, providerId, {
      clientId: "client_abc",
      clientSecret: "secret_xyz",
    });

    // Mock provider returns a fresh access_token on the refresh call.
    mockServer.setTokenResponse({
      access_token: "fresh_token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const captured: Array<{ authorization: string | null }> = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) {
        // Real fetch through to the mock OAuth server for the token call.
        return fetch(url, init);
      }
      const auth = new Headers(init.headers).get("authorization");
      captured.push({ authorization: auth });
      // First upstream call → 401, second → 200.
      const status = captured.length === 1 ? 401 : 200;
      return Promise.resolve(
        new Response(status === 200 ? '{"messages":[]}' : "expired", {
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
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.authorization).toBe("Bearer stale_token");
    expect(captured[1]!.authorization).toBe("Bearer fresh_token");
    expect(res.authRefreshed).toBeUndefined();

    // The mock server received exactly one /token refresh request.
    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(tokenReqs).toHaveLength(1);
    const refreshBody = new URLSearchParams(tokenReqs[0]!.body);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("rt_valid");
  });

  it("surfaces the original 401 when the refresh itself fails (invalid_grant)", async () => {
    const providerId = "@cprefreshorg/gmail-revoked";
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
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          oauth2: {
            authorizationUrl: `${mockServer.url}/authorize`,
            tokenUrl: `${mockServer.url}/token`,
          },
        },
      },
    });

    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      access_token: "stale_token",
      refresh_token: "rt_revoked",
    });
    await setAdminOAuthCredentials(ctx.defaultAppId, providerId, {
      clientId: "client_abc",
      clientSecret: "secret_xyz",
    });

    // Mock the upstream provider to reject the refresh with invalid_grant.
    mockServer.setTokenStatus(400);
    mockServer.setTokenResponse({ error: "invalid_grant" });

    let upstreamCalls = 0;
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      upstreamCalls += 1;
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    const res = await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(401);
    // Only ONE upstream call — the refresh exception aborts the retry path.
    expect(upstreamCalls).toBe(1);
    expect(res.authRefreshed).toBeUndefined();
  });

  it("does not retry when upstream returns a non-401 response", async () => {
    const providerId = "@cprefreshorg/gmail-403";
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
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          oauth2: {
            authorizationUrl: `${mockServer.url}/authorize`,
            tokenUrl: `${mockServer.url}/token`,
          },
        },
      },
    });

    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      access_token: "valid_token",
      refresh_token: "rt_valid",
    });
    await setAdminOAuthCredentials(ctx.defaultAppId, providerId, {
      clientId: "client_abc",
      clientSecret: "secret_xyz",
    });

    let upstreamCalls = 0;
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      upstreamCalls += 1;
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }) as unknown as typeof fetch;

    const res = await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(403);
    expect(upstreamCalls).toBe(1);

    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(tokenReqs).toHaveLength(0);
  });

  it("keeps the streaming-body authRefreshed escape-hatch (regression)", async () => {
    const providerId = "@cprefreshorg/gmail-stream";
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
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          oauth2: {
            authorizationUrl: `${mockServer.url}/authorize`,
            tokenUrl: `${mockServer.url}/token`,
          },
        },
      },
    });

    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      access_token: "stale_token",
      refresh_token: "rt_valid",
    });
    await setAdminOAuthCredentials(ctx.defaultAppId, providerId, {
      clientId: "client_abc",
      clientSecret: "secret_xyz",
    });

    mockServer.setTokenResponse({
      access_token: "fresh_token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    let upstreamCalls = 0;
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      upstreamCalls += 1;
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("upload-bytes"));
        controller.close();
      },
    });

    const res = await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "POST",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: { "Content-Type": "application/octet-stream" },
      body: stream,
      fetch: fakeFetch,
    });

    // Streaming body cannot be replayed → exactly ONE upstream call,
    // creds rotated server-side, authRefreshed surfaced to the caller.
    expect(res.status).toBe(401);
    expect(res.authRefreshed).toBe(true);
    expect(upstreamCalls).toBe(1);

    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(tokenReqs).toHaveLength(1);
  });
});
