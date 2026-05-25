// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the 401-refresh-retry path in the public
 * credential-proxy core (issue #332), re-platformed onto
 * `integration_connections`.
 *
 * Buffered bodies trigger a force-refresh of the integration connection's
 * OAuth2 token, the rotated credential header is re-injected, and the
 * upstream call is replayed exactly once. Streaming bodies keep their
 * `authRefreshed: true` escape-hatch (cannot be replayed server-side).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";
import { createMockOAuthServer, type MockOAuthServer } from "../../helpers/oauth-server.ts";
import {
  applicationPackages,
  integrationConnections,
  integrationOauthClients,
} from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const mockServer: MockOAuthServer = createMockOAuthServer();

afterAll(() => {
  mockServer.stop();
});

function oauthManifest(name: string): IntegrationManifest {
  return localIntegrationManifest({
    name,
    displayName: "Gmail",
    description: "Gmail integration",
    auths: {
      google: {
        type: "oauth2",
        authorizationEndpoint: `${mockServer.url}/authorize`,
        tokenEndpoint: `${mockServer.url}/token`,
        defaultScopes: ["openid", "email"],
        authorizedUris: ["https://gmail.googleapis.com/**"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "access_token",
        }),
      },
    },
  });
}

async function setup(
  ctx: TestContext,
  packageId: string,
  fields: Record<string, string>,
): Promise<void> {
  await seedPackage({
    id: packageId,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: oauthManifest(packageId),
  });
  await db.insert(applicationPackages).values({
    applicationId: ctx.defaultAppId,
    packageId,
    config: {},
  });
  await db.insert(integrationConnections).values({
    integrationPackageId: packageId,
    authKey: "google",
    accountId: "acct-1",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentials(fields),
    scopesGranted: ["openid", "email"],
    sharedWithOrg: false,
    expiresAt: new Date(Date.now() - 60_000),
  });
  await db.insert(integrationOauthClients).values({
    applicationId: ctx.defaultAppId,
    integrationPackageId: packageId,
    authKey: "google",
    clientId: "client_abc",
    clientSecretEncrypted: encryptCredentials({ client_secret: "secret_xyz" }),
  });
}

describe("proxyCall — 401 refresh-retry on buffered bodies (integration-backed)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    mockServer.clearRequests();
    mockServer.setTokenStatus(200);
    ctx = await createTestContext({ orgSlug: "cprefreshorg" });
  });

  it("refreshes the OAuth2 token and retries the call when upstream returns 401", async () => {
    const packageId = "@cprefreshorg/gmail";
    await setup(ctx, packageId, { access_token: "stale_token", refresh_token: "rt_valid" });

    mockServer.setTokenResponse({
      access_token: "fresh_token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const captured: Array<{ authorization: string | null }> = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      const auth = new Headers(init.headers).get("authorization");
      captured.push({ authorization: auth });
      const status = captured.length === 1 ? 401 : 200;
      return Promise.resolve(
        new Response(status === 200 ? '{"messages":[]}' : "expired", {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const res = await proxyCall({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
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

    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(tokenReqs).toHaveLength(1);
    const refreshBody = new URLSearchParams(tokenReqs[0]!.body);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("rt_valid");
  });

  it("surfaces the original 401 when the refresh itself fails (invalid_grant)", async () => {
    const packageId = "@cprefreshorg/gmail-revoked";
    await setup(ctx, packageId, { access_token: "stale_token", refresh_token: "rt_revoked" });

    mockServer.setTokenStatus(400);
    mockServer.setTokenResponse({ error: "invalid_grant" });

    let upstreamCalls = 0;
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      upstreamCalls += 1;
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    const res = await proxyCall({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(401);
    expect(upstreamCalls).toBe(1);
    expect(res.authRefreshed).toBeUndefined();
  });

  it("does not retry when upstream returns a non-401 response", async () => {
    const packageId = "@cprefreshorg/gmail-403";
    await setup(ctx, packageId, { access_token: "valid_token", refresh_token: "rt_valid" });

    let upstreamCalls = 0;
    const fakeFetch = ((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.startsWith(mockServer.url)) return fetch(url, init);
      upstreamCalls += 1;
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }) as unknown as typeof fetch;

    const res = await proxyCall({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
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
    const packageId = "@cprefreshorg/gmail-stream";
    await setup(ctx, packageId, { access_token: "stale_token", refresh_token: "rt_valid" });

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

    const res = await proxyCall({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "POST",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: { "Content-Type": "application/octet-stream" },
      body: stream,
      fetch: fakeFetch,
    });

    expect(res.status).toBe(401);
    expect(res.authRefreshed).toBe(true);
    expect(upstreamCalls).toBe(1);

    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(tokenReqs).toHaveLength(1);
  });
});
