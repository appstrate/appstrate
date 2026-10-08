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

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedPackage,
  seedPackageShare,
  seedRun,
  seedPublishedVersion,
} from "../../helpers/seed.ts";
import { proxyCall, ProxyCallError } from "../../../src/services/credential-proxy/core.ts";
import { runBoundSelection } from "../../../src/services/credential-proxy/integration-resolver.ts";
import { LocalCookieJarStore } from "../../../src/infra/cookie-jar/local-cookie-jar.ts";
import { createMockOAuthServer, type MockOAuthServer } from "../../helpers/oauth-server.ts";
import {
  spacePackages,
  integrationConnections,
  integrationOauthClients,
  runs,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope, encryptCredentials } from "@appstrate/connect";
import { eq } from "drizzle-orm";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const mockServer: MockOAuthServer = createMockOAuthServer();

afterAll(() => {
  mockServer.stop();
});

const BEARER_DELIVERY = httpHeaderDelivery({
  name: "Authorization",
  prefix: "Bearer ",
  field: "access_token",
});

function oauthManifest(name: string, delivery = BEARER_DELIVERY): IntegrationManifest {
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
        delivery,
      },
    },
  });
}

async function setup(
  ctx: TestContext,
  packageId: string,
  fields: Record<string, string>,
  delivery = BEARER_DELIVERY,
): Promise<void> {
  await seedPackage({
    id: packageId,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: oauthManifest(packageId, delivery),
  });
  await seedPublishedVersion(packageId, "1.0.0");
  // The OFFER is the PLACEMENT: a `space_packages` row only speaks for a space
  // the package is placed in, so switching an unplaced integration on leaves it
  // inactive.
  await seedPackageShare(ctx.defaultSpaceId, packageId);
  await db.insert(spacePackages).values({
    spaceId: ctx.defaultSpaceId,
    packageId,
  });
  // Register the org's custom per-space client first so its id can pin the
  // connection (client_ref is a flat client id).
  const [customClient] = await db
    .insert(integrationOauthClients)
    .values({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      integrationId: packageId,
      authKey: "google",
      clientId: "client_abc",
      clientSecretEncrypted: encryptCredentials({ client_secret: "secret_xyz" }),
    })
    .returning({ id: integrationOauthClients.id });
  await db.insert(integrationConnections).values({
    integrationId: packageId,
    authKey: "google",
    accountId: "acct-1",
    label: "acct-1",
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: fields }),
    scopesGranted: ["openid", "email"],
    sharedWithOrg: false,
    // oauth2 connections always pin their minting client by id; here the org's
    // custom per-space client registered just above.
    clientRef: customClient!.id,
    expiresAt: new Date(Date.now() - 60_000),
  });
}

/**
 * Seed an integration + a connection pinned to a SYSTEM client (no custom
 * per-space client row). Refresh can only succeed by resolving the env system
 * client — proving the `client_ref` pin threads from the connection SELECT
 * through `selectAccessibleConnection` into `buildIntegrationOAuthRefreshContext`.
 */
async function setupSystemPinned(
  ctx: TestContext,
  packageId: string,
  systemId: string,
  fields: Record<string, string>,
): Promise<void> {
  await seedPackage({
    id: packageId,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: oauthManifest(packageId),
  });
  await seedPublishedVersion(packageId, "1.0.0");
  // The OFFER is the PLACEMENT: a `space_packages` row only speaks for a space
  // the package is placed in, so switching an unplaced integration on leaves it
  // inactive.
  await seedPackageShare(ctx.defaultSpaceId, packageId);
  await db.insert(spacePackages).values({
    spaceId: ctx.defaultSpaceId,
    packageId,
  });
  await db.insert(integrationConnections).values({
    integrationId: packageId,
    authKey: "google",
    accountId: "acct-1",
    label: "acct-1",
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: fields }),
    scopesGranted: ["openid", "email"],
    sharedWithOrg: false,
    clientRef: systemId,
    expiresAt: new Date(Date.now() - 60_000),
  });
  initSystemIntegrations([
    {
      id: packageId,
      clients: [
        {
          id: systemId,
          auth_key: "google",
          client_id: "system_client_id",
          client_secret: "system_secret",
        },
      ],
    },
  ]);
}

describe("proxyCall — 401 refresh-retry on buffered bodies (integration-backed)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    mockServer.clearRequests();
    mockServer.setTokenStatus(200);
    __resetSystemIntegrationsForTest();
    ctx = await createTestContext({ orgSlug: "cprefreshorg" });
  });

  afterEach(() => __resetSystemIntegrationsForTest());

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
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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

  it("refreshes the connection the call used, even when a fresh selection would now be ambiguous", async () => {
    const packageId = "@cprefreshorg/gmail-second";
    await setup(ctx, packageId, { access_token: "stale_token", refresh_token: "rt_valid" });
    mockServer.setTokenResponse({
      access_token: "fresh_token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const captured: Array<string | null> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (String(url).startsWith(mockServer.url)) return fetch(url, init);
      captured.push(new Headers(init.headers).get("authorization"));
      if (captured.length === 1) {
        // A second own connection lands between the call and its retry: re-running the
        // selection would 409 `must_choose_connection` and the refresh would be lost.
        await db.insert(integrationConnections).values({
          integrationId: packageId,
          authKey: "google",
          accountId: "acct-2",
          label: "acct-2",
          spaceId: ctx.defaultSpaceId,
          userId: ctx.user.id,
          credentialsEncrypted: encryptCredentialEnvelope({
            outputs: { access_token: "other_token", refresh_token: "rt_other" },
          }),
          scopesGranted: ["openid", "email"],
          sharedWithOrg: false,
        });
        return new Response("expired", { status: 401 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const res = await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured).toEqual(["Bearer stale_token", "Bearer fresh_token"]);
    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(new URLSearchParams(tokenReqs[0]!.body).get("refresh_token")).toBe("rt_valid");
  });

  it("re-applies session cookies to the retry after a refresh (#1613)", async () => {
    const packageId = "@cprefreshorg/gmail-cookie";
    await setup(
      ctx,
      packageId,
      { access_token: "stale_token", refresh_token: "rt_valid" },
      httpHeaderDelivery({ name: "Cookie", prefix: "at=", field: "access_token" }),
    );
    mockServer.setTokenResponse({
      access_token: "fresh_token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    // Call 1 sets `sid`; call 2 answers 401 once, then 200 on the retry.
    const sent: string[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      if (String(url).startsWith(mockServer.url)) return fetch(url, init);
      sent.push(new Headers(init.headers).get("cookie") ?? "");
      const headers = new Headers(sent.length === 1 ? { "Set-Cookie": "sid=1; Path=/" } : {});
      return Promise.resolve(
        new Response("{}", { status: sent.length === 2 ? 401 : 200, headers }),
      );
    }) as unknown as typeof fetch;
    const jar = new LocalCookieJarStore();
    const call = () =>
      proxyCall({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        actor: { type: "user", id: ctx.user.id },
        integrationId: packageId,
        method: "GET",
        target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        headers: {},
        cookieJar: jar,
        jarSessionId: "session-refresh",
        cookieJarTtlSeconds: 600,
        fetch: fakeFetch,
      });

    await call();
    const res = await call();

    expect(res.status).toBe(200);
    const pairs = (cookie: string | undefined) => cookie?.split("; ").sort();
    expect(pairs(sent[1])).toEqual(["at=stale_token", "sid=1"]);
    expect(pairs(sent[2])).toEqual(["at=fresh_token", "sid=1"]);
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
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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

  it("answers the 503 — not the upstream 401 — when the refresh meets a missing key", async () => {
    const packageId = "@cprefreshorg/gmail-missing-kid";
    await setup(ctx, packageId, { access_token: "stale_token", refresh_token: "rt_valid" });
    await db
      .update(integrationOauthClients)
      .set({ clientSecretEncrypted: `v1:k0gone:${Buffer.alloc(40).toString("base64")}` })
      .where(eq(integrationOauthClients.integrationId, packageId));
    const fakeFetch = ((url: string, init: RequestInit) =>
      String(url).startsWith(mockServer.url)
        ? fetch(url, init)
        : Promise.resolve(
            new Response("unauthorized", { status: 401 }),
          )) as unknown as typeof fetch;
    const call = (body?: ReadableStream<Uint8Array>) =>
      proxyCall({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        actor: { type: "user", id: ctx.user.id },
        integrationId: packageId,
        method: body ? "POST" : "GET",
        target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        headers: body ? { "Content-Type": "application/octet-stream" } : {},
        ...(body ? { body } : {}),
        fetch: fakeFetch,
      });
    const unavailable = { code: "encryption_key_unavailable" };

    // Buffered (replayable) and streaming bodies alike: no relayed 401, no `authRefreshed`.
    await expect(call()).rejects.toBeInstanceOf(ProxyCallError);
    await expect(call()).rejects.toMatchObject(unavailable);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("upload-bytes"));
        controller.close();
      },
    });
    await expect(call(stream)).rejects.toMatchObject(unavailable);

    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, packageId));
    expect(row!.needsReconnection).toBe(false);
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
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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

  it("refreshes a SYSTEM-pinned connection using the env system client (end-to-end)", async () => {
    // No custom per-space client row exists — refresh can ONLY succeed by resolving
    // the system client via the connection's `client_ref` (the system id). Proves
    // the pin threads from the connection SELECT through selectAccessibleConnection
    // into buildIntegrationOAuthRefreshContext.
    const packageId = "@cprefreshorg/gmail-system";
    await setupSystemPinned(ctx, packageId, "gmail-system", {
      access_token: "stale_token",
      refresh_token: "rt_valid",
    });

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
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(captured[1]!.authorization).toBe("Bearer fresh_token");

    // The refresh POST authenticated as the SYSTEM client (default auth method
    // client_secret_basic → Authorization: Basic base64(client_id:secret)).
    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    expect(tokenReqs).toHaveLength(1);
    const authHeader = tokenReqs[0]!.headers?.authorization ?? "";
    const decoded = authHeader.startsWith("Basic ")
      ? Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8")
      : "";
    expect(decoded).toBe("system_client_id:system_secret");
  });
});

describe("proxyCall — an X-Run-Id run is re-checked on the 401 refresh", () => {
  const packageId = "@cprefreshorg/gmail-run";
  let ctx: TestContext;
  let runId: string;

  beforeEach(async () => {
    await truncateAll();
    mockServer.clearRequests();
    mockServer.setTokenStatus(200);
    mockServer.setTokenResponse({
      access_token: "fresh_token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    ctx = await createTestContext({ orgSlug: "cprefreshorg" });
    await setup(ctx, packageId, { access_token: "stale_token", refresh_token: "rt_valid" });
    const [conn] = await db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, packageId));
    await seedPackage({
      id: "@cprefreshorg/agent",
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
    });
    const run = await seedRun({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      packageId: "@cprefreshorg/agent",
      userId: ctx.user.id,
      status: "running",
      runOrigin: "remote",
      resolvedConnections: {
        [packageId]: [
          { connectionId: conn!.id, source: "member_pin", label: "conn", accountId: "acct" },
        ],
      },
    });
    runId = run.id;
  });

  /** Upstream 401s once, then 200s; `onFirst` runs before the 401 is returned. */
  async function callThroughRun(onFirst: () => Promise<void>) {
    let upstreamCalls = 0;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (String(url).startsWith(mockServer.url)) return fetch(url, init);
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        await onFirst();
        return new Response("expired", { status: 401 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const actor = { type: "user" as const, id: ctx.user.id };
    const res = await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor,
      integrationId: packageId,
      run: runBoundSelection({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        runId,
        integrationId: packageId,
        actor,
      }),
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });
    const tokenReqs = mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");
    return { status: res.status, upstreamCalls, refreshes: tokenReqs.length };
  }

  it("refreshes and retries while the run is in flight (control)", async () => {
    expect(await callThroughRun(async () => {})).toEqual({
      status: 200,
      upstreamCalls: 2,
      refreshes: 1,
    });
  });

  it("does not refresh through a run that finished before the retry — the original 401 stands", async () => {
    const finish = async () => {
      await db.update(runs).set({ status: "success" }).where(eq(runs.id, runId));
    };
    expect(await callThroughRun(finish)).toEqual({ status: 401, upstreamCalls: 1, refreshes: 0 });
  });
});

describe("proxyCall — an api_key connection's rejection streak", () => {
  const packageId = "@cprefreshorg/apikey";
  let ctx: TestContext;
  let connId: string;

  /** An api_key integration active in the default space, with a connection 3 rejections deep. */
  async function seedRejectedConnection(id: string): Promise<string> {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: id,
        auths: {
          key: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            delivery: httpHeaderDelivery({ name: "X-Api-Key", field: "api_key" }),
          },
        },
      }),
    });
    await seedPublishedVersion(id, "1.0.0");
    await seedPackageShare(ctx.defaultSpaceId, id);
    await db.insert(spacePackages).values({ spaceId: ctx.defaultSpaceId, packageId: id });
    const [conn] = await db
      .insert(integrationConnections)
      .values({
        integrationId: id,
        authKey: "key",
        accountId: "acct-1",
        label: "acct-1",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        refreshFailureCount: 3,
      })
      .returning({ id: integrationConnections.id });
    return conn!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cprefreshorg" });
    connId = await seedRejectedConnection(packageId);
  });

  async function callReturning(status: number, integrationId = packageId): Promise<number> {
    const res = await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId,
      method: "GET",
      target: "https://api.example.com/v1/items",
      headers: {},
      fetch: (async () => new Response("{}", { status })) as unknown as typeof fetch,
    });
    return res.status;
  }

  async function failures(id = connId): Promise<number> {
    const [row] = await db
      .select({ count: integrationConnections.refreshFailureCount })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    return row!.count;
  }

  /** The streak is cleared in the background, after the call returns. */
  async function clearedWithin(id: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while ((await failures(id)) !== 0 && Date.now() < deadline) await Bun.sleep(10);
    return (await failures(id)) === 0;
  }

  it("a 2xx ends the streak", async () => {
    expect(await callReturning(200)).toBe(200);
    expect(await clearedWithin(connId, 1000)).toBe(true);
  });

  it("a non-2xx leaves it", async () => {
    const sentinelId = "@cprefreshorg/sentinel";
    const sentinel = await seedRejectedConnection(sentinelId);

    expect(await callReturning(403)).toBe(403);
    // Had the 403 started a clear, it would be issued before this 2xx's: once
    // this one has landed, that one would have too.
    expect(await callReturning(200, sentinelId)).toBe(200);
    expect(await clearedWithin(sentinel, 1000)).toBe(true);

    expect(await failures()).toBe(3);
  });
});
