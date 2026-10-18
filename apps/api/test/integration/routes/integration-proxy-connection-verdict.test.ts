// SPDX-License-Identifier: Apache-2.0
/**
 * `GET /api/integrations/{packageId}` → `proxy_connection`: the selection a credential-proxy call
 * outside a run would make for the caller, read through the proxy's own function. Each case that
 * refuses is checked against the proxy route itself, which answers before any upstream call.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationConnections,
  integrationConnectionShares,
  integrationOrgDefaults,
  spacePackages,
} from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { seedApiKey, seedPackage } from "../../helpers/seed.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import {
  authHeaders,
  createTestContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const ID = "@verdict/docs";

const manifest = localIntegrationManifest({
  name: ID,
  auths: {
    api: {
      type: "api_key",
      authorizedUris: ["https://1.1.1.1/**"],
      delivery: httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" }),
    },
  },
});

const verdict = async (ctx: TestContext) => {
  const res = await getTestApp().request(`/api/integrations/${ID}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { proxy_connection: { status: string; imposed: boolean } };
  return body.proxy_connection;
};

/**
 * The proxy route's own answer for an unnamed call outside a run, through an API key of the
 * caller's (the route takes a bearer only) carrying the proxy permission the caller holds.
 */
const proxied = async (ctx: TestContext, scope = "credential-proxy:call") => {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes: [scope],
  });
  const res = await getTestApp().request("/api/credential-proxy/proxy", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key.rawKey}`,
      "X-Integration-Id": ID,
      "X-Target": "https://1.1.1.1/v1",
      "X-Session-Id": crypto.randomUUID(),
    },
  });
  return { status: res.status, code: ((await res.json()) as { code?: string }).code };
};

describe("GET /api/integrations/{packageId} — proxy_connection", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "verdict" });
    await seedProxyIntegration(ctx, manifest);
  });

  const shareIntoSpace = (connectionId: string) =>
    db
      .insert(integrationConnectionShares)
      .values({ connectionId, orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
  const enforce = (connectionIds: string[]) =>
    db.insert(integrationOrgDefaults).values({
      spaceId: ctx.defaultSpaceId,
      integrationId: ID,
      connectionIds,
      enforce: true,
    });

  it("is ready on the caller's own healthy connection", async () => {
    await seedProxyConnection(ctx, ID, "api", { api_key: "sk" });
    expect(await verdict(ctx)).toEqual({ status: "ready", imposed: false });
  });

  it("is not_required for an integration declaring no auths (AFPS §7.2)", async () => {
    const OPEN = "@verdict/open";
    const { auths: _auths, ...open } = remoteIntegrationManifest({ name: OPEN, auths: {} });
    await seedProxyIntegration(ctx, open as IntegrationManifest);
    const res = await getTestApp().request(`/api/integrations/${OPEN}`, {
      headers: authHeaders(ctx),
    });
    const body = (await res.json()) as { proxy_connection: { status: string; imposed: boolean } };
    expect(body.proxy_connection).toEqual({ status: "not_required", imposed: false });
  });

  it("is none without a connection, as the proxy answers", async () => {
    expect(await verdict(ctx)).toEqual({ status: "none", imposed: false });
    expect((await proxied(ctx)).code).toBe("credential_not_found");
  });

  it("asks for a choice between two own connections, as the proxy does", async () => {
    await seedProxyConnection(ctx, ID, "api", { api_key: "a" }, "acct-1");
    await seedProxyConnection(ctx, ID, "api", { api_key: "b" }, "acct-2");
    expect(await verdict(ctx)).toEqual({ status: "must_choose", imposed: false });
    expect((await proxied(ctx)).code).toBe("must_choose_connection");
  });

  it("is not ready when the enforced org default is dead, whatever the caller's own connection", async () => {
    const imposed = await seedProxyConnection(ctx, ID, "api", { api_key: "org" }, "org");
    await shareIntoSpace(imposed);
    await db
      .update(integrationConnections)
      .set({ needsReconnection: true })
      .where(eq(integrationConnections.id, imposed));
    await enforce([imposed]);
    const caller = await memberHolding(ctx, ["integrations:read", "credential-proxy:call"]);
    await seedProxyConnection(caller, ID, "api", { api_key: "own" }, "own");

    expect(await verdict(caller)).toEqual({ status: "needs_reconnection", imposed: true });
    expect((await proxied(caller)).code).toBe("needs_reconnection");
  });

  it("names an org default it cannot bind as default_unavailable", async () => {
    const imposed = await seedProxyConnection(ctx, ID, "api", { api_key: "org" }, "org");
    await enforce([imposed]);
    await db.delete(integrationConnections).where(eq(integrationConnections.id, imposed));
    expect(await verdict(ctx)).toEqual({ status: "default_unavailable", imposed: true });
    expect((await proxied(ctx)).code).toBe("pinned_connection_unavailable");
  });

  it("gives a call-own caller with only a shared connection the proxy's answer", async () => {
    const shared = await seedProxyConnection(ctx, ID, "api", { api_key: "org" }, "org");
    await shareIntoSpace(shared);
    const caller = await memberHolding(ctx, ["integrations:read", "credential-proxy:call-own"]);
    // Its own reach holds none of a colleague's rows.
    expect(await verdict(caller)).toEqual({ status: "none", imposed: false });
    expect((await proxied(caller, "credential-proxy:call-own")).code).toBe("credential_not_found");

    // Under an enforced default, the own reach is refused outright.
    await enforce([shared]);
    expect(await verdict(caller)).toEqual({ status: "not_permitted", imposed: true });
    expect((await proxied(caller, "credential-proxy:call-own")).code).toBe(
      "call_permission_required",
    );
  });

  it("is not_permitted for a caller holding neither proxy permission, as the proxy refuses", async () => {
    const caller = await memberHolding(ctx, ["integrations:read", "integrations:connect"]);
    await seedProxyConnection(caller, ID, "api", { api_key: "own" }, "own");
    expect(await verdict(caller)).toEqual({ status: "not_permitted", imposed: false });
  });

  it("judges a never-published integration on its draft, the manifest the detail serves", async () => {
    const draftOnly = "@verdict/draft";
    await seedPackage({
      id: draftOnly,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      // An auth only the draft declares: a connection on it is selected.
      draftManifest: localIntegrationManifest({
        name: draftOnly,
        auths: {
          draft_auth: {
            type: "api_key",
            authorizedUris: ["https://1.1.1.1/**"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
      }),
    });
    await db
      .insert(spacePackages)
      .values({ enabled: true, spaceId: ctx.defaultSpaceId, packageId: draftOnly });
    const res = (id: string) =>
      getTestApp().request(`/api/integrations/${id}`, { headers: authHeaders(ctx) });
    const read = async () =>
      ((await (await res(draftOnly)).json()) as { proxy_connection: unknown }).proxy_connection;
    expect(await read()).toEqual({ status: "none", imposed: false });
    await seedProxyConnection(ctx, draftOnly, "draft_auth", { api_key: "sk" });
    expect(await read()).toEqual({ status: "ready", imposed: false });
  });

  it("lets a call caller reach a colleague's shared connection only by naming it", async () => {
    const shared = await seedProxyConnection(ctx, ID, "api", { api_key: "org" }, "org");
    await shareIntoSpace(shared);
    const caller = await memberHolding(ctx, ["integrations:read", "credential-proxy:call"]);
    expect(await verdict(caller)).toEqual({ status: "must_choose", imposed: false });
    expect((await proxied(caller)).code).toBe("must_choose_connection");
  });
});
