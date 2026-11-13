// SPDX-License-Identifier: Apache-2.0
/**
 * `GET /api/credential-proxy/integrations` at the route boundary: each integration active in the
 * space with the verdict of a call outside a run naming no connection, and the connect link of a
 * refusal a connect flow clears.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, spacePackages, spaces } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";

const ID = "@acme/mail";
const OFFERS = { "X-Appstrate-Connect-Offers": "1" };

/** An integration whose one auth is oauth2 with a consent screen: what a connect link serves. */
const oauthManifest = (name = ID): IntegrationManifest => {
  const manifest = remoteIntegrationManifest({ name, displayName: "Acme Mail", auths: {} });
  return {
    ...manifest,
    auths: {
      oauth: {
        type: "oauth2",
        authorization_endpoint: "https://idp.example.com/authorize",
        token_endpoint: "https://idp.example.com/token",
        authorized_uris: ["https://api.example.com/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
      },
    },
  } as unknown as IntegrationManifest;
};

interface Entry {
  integration_package_id: string;
  display_name: string;
  proxy_connection: { status: string; imposed: boolean };
  refusal?: Record<string, unknown>;
}

describe("GET /api/credential-proxy/integrations", () => {
  let ctx: TestContext;
  let apiKey: string;

  const list = async (headers: Record<string, string> = {}) => {
    const res = await getTestApp().request("/api/credential-proxy/integrations", {
      headers: {
        ...headers,
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
      },
    });
    return { status: res.status, body: (await res.json()) as { data: Entry[]; code?: string } };
  };

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "acme" });
    apiKey = (
      await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["credential-proxy:call-own", "integrations:connect"],
      })
    ).rawKey;
    await seedProxyIntegration(ctx, oauthManifest());
  });

  it("lists an integration without a connection as `none`, with the item a connect flow targets", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.data).toEqual([
      {
        integration_package_id: ID,
        display_name: "Acme Mail",
        proxy_connection: { status: "none", imposed: false },
        refusal: expect.objectContaining({
          field: `integrations.${ID}`,
          code: "not_connected",
          auth_key: "oauth",
        }),
      },
    ]);
    expect(body.data[0]!.refusal).not.toHaveProperty("connect_url");
  });

  it("carries a connect link on that item when asked for", async () => {
    const { body } = await list(OFFERS);
    expect(body.data[0]!.refusal).toMatchObject({ code: "not_connected", packageId: ID });
    expect(body.data[0]!.refusal!.connect_url).toStartWith("http");
  });

  it("reconnects the caller's own connection that needs it, when asked for", async () => {
    const connectionId = await seedProxyConnection(ctx, ID, "oauth", { access_token: "t" });
    await db
      .update(integrationConnections)
      .set({ needsReconnection: true })
      .where(eq(integrationConnections.id, connectionId));
    const { body } = await list(OFFERS);
    expect(body.data[0]!.proxy_connection.status).toBe("needs_reconnection");
    expect(body.data[0]!.refusal).toMatchObject({
      code: "needs_reconnection",
      connection_id: connectionId,
    });
    expect(body.data[0]!.refusal!.connect_url).toStartWith("http");
  });

  it("lists a connected integration as `ready`, without a refusal", async () => {
    await seedProxyConnection(ctx, ID, "oauth", { access_token: "t" });
    const { body } = await list(OFFERS);
    expect(body.data).toEqual([
      {
        integration_package_id: ID,
        display_name: "Acme Mail",
        proxy_connection: { status: "ready", imposed: false },
      },
    ]);
  });

  it("omits an integration switched off in the space", async () => {
    await db
      .update(spacePackages)
      .set({ enabled: false })
      .where(and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.packageId, ID)));
    expect((await list()).body.data).toEqual([]);
  });

  it("is refused in a space whose credential proxy is closed", async () => {
    await db
      .update(spaces)
      .set({ credentialProxyOpen: false })
      .where(eq(spaces.id, ctx.defaultSpaceId));
    const { status, body } = await list();
    expect(status).toBe(403);
    expect(body.code).toBe("credential_proxy_closed");
  });
});
