// SPDX-License-Identifier: Apache-2.0
/**
 * `GET /api/credential-proxy/tools` at the route boundary, for integrations without a remote
 * server: the `api_call` tools a call outside a run reaches, each named by its integration's
 * normalised package id (a hash of the id apart when two normalise alike), with the connections
 * each reaches, and the integrations active in the space without a usable
 * connection, with the connect link of a refusal a connect flow clears. The typed tools of a remote
 * server are covered in `credential-proxy-remote-tools.test.ts`.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationConnections,
  integrationOrgDefaults,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { fnv1a64Hex } from "@appstrate/afps-shared/mcp-naming";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import {
  apiIntegrationManifest,
  twoAuthApiIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const ID = "@acme/mail";
const OFFERS = { "X-Appstrate-Connect-Offers": "1" };

/** An `api_call` integration whose one auth is oauth2 with a consent screen: what a connect link serves. */
const oauthManifest = (name = ID): IntegrationManifest =>
  ({
    ...apiIntegrationManifest({ name, displayName: "Acme Mail", auths: {} }),
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
    _meta: { "dev.appstrate/api": { auths: { oauth: {} } } },
  }) as unknown as IntegrationManifest;

/** An `api_call` integration on one api_key auth. */
const keyManifest = (name: string, extra: Record<string, unknown> = {}): IntegrationManifest =>
  ({
    ...apiIntegrationManifest({
      name,
      apiCall: { authKey: "api" },
      auths: { api: { type: "api_key", authorizedUris: ["https://api.example.com/**"] } },
    }),
    ...extra,
  }) as IntegrationManifest;

interface NotReady {
  integration_package_id: string;
  display_name: string;
  proxy_connection: { status: string; imposed: boolean };
  refusal?: Record<string, unknown>;
}
interface Tool {
  name: string;
  kind: string;
  integration_package_id: string;
  auth_key?: string;
  connection_required?: boolean;
  connections: { connection_id: string }[];
}
interface Listing {
  tools: Tool[];
  not_ready: NotReady[];
  unlisted: unknown[];
  truncated_catalogs: unknown[];
  code?: string;
}

describe("GET /api/credential-proxy/tools", () => {
  let ctx: TestContext;
  let apiKey: string;

  const list = async (query: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const res = await getTestApp().request(
      `/api/credential-proxy/tools?${new URLSearchParams(query).toString()}`,
      {
        headers: {
          ...headers,
          Authorization: `Bearer ${apiKey}`,
          "X-Org-Id": ctx.orgId,
          "X-Space-Id": ctx.defaultSpaceId,
        },
      },
    );
    return { status: res.status, body: (await res.json()) as Listing };
  };

  /** The space's org default of {@link ID}. */
  const orgDefault = (connectionIds: string[], enforce: boolean) =>
    db.insert(integrationOrgDefaults).values({
      spaceId: ctx.defaultSpaceId,
      integrationId: ID,
      connectionIds,
      enforce,
    });

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
  });

  describe("not_ready", () => {
    beforeEach(() => seedProxyIntegration(ctx, oauthManifest()));

    it("lists an integration without a connection as `none`, with the item a connect flow targets", async () => {
      const { status, body } = await list();
      expect(status).toBe(200);
      expect(body).toEqual({
        tools: [],
        not_ready: [
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
        ],
        unlisted: [],
        truncated_catalogs: [],
      });
      expect(body.not_ready[0]!.refusal).not.toHaveProperty("connect_url");
    });

    it("carries a connect link on that item when asked for", async () => {
      const { body } = await list({}, OFFERS);
      expect(body.not_ready[0]!.refusal).toMatchObject({ code: "not_connected", packageId: ID });
      expect(body.not_ready[0]!.refusal!.connect_url).toStartWith("http");
    });

    it("renders a connect link that, opened, sends the user to the provider's consent screen", async () => {
      // An administrator registered the auth's OAuth client: the link has a provider to reach.
      const registered = await getTestApp().request(
        `/api/integrations/${ID}/auths/oauth/oauth-clients`,
        {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
        },
      );
      expect(registered.status).toBe(201);
      const { body } = await list({}, OFFERS);
      const link = new URL(String(body.not_ready[0]!.refusal!.connect_url));
      expect(link.pathname).toBe("/api/integrations/connect/start");
      // Redeemed as the user would open it: no credential, the link alone.
      const opened = await getTestApp().request(link.pathname + link.search, {
        redirect: "manual",
      });
      expect(opened.status).toBe(302);
      const location = new URL(opened.headers.get("location")!);
      expect(location.origin + location.pathname).toBe("https://idp.example.com/authorize");
      expect(location.searchParams.get("client_id")).toBe("abc");
    });

    it("carries no connect link for a caller without `integrations:connect`, asked for or not", async () => {
      apiKey = (
        await seedApiKey({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          createdBy: ctx.user.id,
          scopes: ["credential-proxy:call-own"],
        })
      ).rawKey;
      const { body } = await list({}, OFFERS);
      // The verdict and its item stay: only the capability to connect is withheld.
      expect(body.not_ready[0]!.refusal).toMatchObject({
        code: "not_connected",
        auth_key: "oauth",
      });
      expect(body.not_ready[0]!.refusal).not.toHaveProperty("connect_url");
    });

    it("lists an integration an enforced org default governs as `not_permitted` for `credential-proxy:call-own` alone", async () => {
      const connectionId = await seedProxyConnection(ctx, ID, "oauth", { access_token: "t" });
      await orgDefault([connectionId], true);
      const { body } = await list();
      expect(body.not_ready).toEqual([
        expect.objectContaining({
          integration_package_id: ID,
          proxy_connection: { status: "not_permitted", imposed: true },
        }),
      ]);
      // A permission refusal names no item a connect flow could clear.
      expect(body.not_ready[0]).not.toHaveProperty("refusal");
    });

    it("lists one whose enforced org default cannot bind as `default_unavailable`", async () => {
      await seedProxyConnection(ctx, ID, "oauth", { access_token: "t" });
      // `credential-proxy:call`: the default binds before the caller's own connection.
      apiKey = (
        await seedApiKey({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          createdBy: ctx.user.id,
          scopes: ["credential-proxy:call"],
        })
      ).rawKey;
      // A member that is no connection the caller reaches.
      await orgDefault([crypto.randomUUID()], true);
      const { body } = await list();
      expect(body.not_ready).toEqual([
        expect.objectContaining({
          integration_package_id: ID,
          proxy_connection: { status: "default_unavailable", imposed: true },
        }),
      ]);
    });

    it("leaves out an integration whose call asks for a choice: its connections are listed on the tool", async () => {
      const first = await seedProxyConnection(ctx, ID, "oauth", { access_token: "a" }, "a");
      const second = await seedProxyConnection(ctx, ID, "oauth", { access_token: "b" }, "b");
      const { body } = await list();
      expect(body.not_ready).toEqual([]);
      expect(body.tools.map((tool) => tool.connections.map((c) => c.connection_id).sort())).toEqual(
        [[first, second].sort()],
      );
    });

    it("reconnects the caller's own connection that needs it, when asked for", async () => {
      const connectionId = await seedProxyConnection(ctx, ID, "oauth", { access_token: "t" });
      await db
        .update(integrationConnections)
        .set({ needsReconnection: true })
        .where(eq(integrationConnections.id, connectionId));
      const { body } = await list({}, OFFERS);
      expect(body.not_ready[0]!.proxy_connection.status).toBe("needs_reconnection");
      expect(body.not_ready[0]!.refusal).toMatchObject({
        code: "needs_reconnection",
        connection_id: connectionId,
      });
      expect(body.not_ready[0]!.refusal!.connect_url).toStartWith("http");
    });

    it("lists a connected integration's tool, and the integration not in `not_ready`", async () => {
      const connectionId = await seedProxyConnection(ctx, ID, "oauth", { access_token: "t" });
      const { body } = await list({}, OFFERS);
      expect(body.not_ready).toEqual([]);
      expect(body.tools).toEqual([
        expect.objectContaining({
          name: "acme_mail__api_call",
          kind: "api_call",
          integration_package_id: ID,
          description: "Acme Mail.",
          auth_key: "oauth",
          connection_required: false,
          connections: [expect.objectContaining({ connection_id: connectionId })],
        }),
      ]);
    });

    it("omits an integration switched off in the space", async () => {
      await db
        .update(spacePackages)
        .set({ enabled: false })
        .where(and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.packageId, ID)));
      expect((await list()).body.not_ready).toEqual([]);
    });

    it("judges the integration named alone, and none when a tool is resolved by name", async () => {
      await seedProxyIntegration(ctx, oauthManifest("@acme/crm"));
      const only = await list({ integration_package_id: "@acme/crm" });
      expect(only.body.not_ready.map((entry) => entry.integration_package_id)).toEqual([
        "@acme/crm",
      ]);
      expect((await list({ name: "acme_mail__api_call" })).body.not_ready).toEqual([]);
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

  describe("api_call tools", () => {
    it("names one tool per auth exposing api_call, each with its own connections", async () => {
      const id = "@acme/items";
      await seedProxyIntegration(ctx, twoAuthApiIntegrationManifest(id));
      const primary = await seedProxyConnection(ctx, id, "primary", { api_key: "a" }, "p");
      const backup1 = await seedProxyConnection(ctx, id, "backup", { api_key: "b" }, "b1");
      const backup2 = await seedProxyConnection(ctx, id, "backup", { api_key: "c" }, "b2");

      const { body } = await list();
      // Auth keys are stored as JSONB: their order is not the author's.
      expect(
        body.tools
          .map((tool) => [
            tool.name,
            tool.auth_key,
            tool.connection_required,
            tool.connections.map((c) => c.connection_id).sort(),
          ])
          .sort(),
      ).toEqual([
        ["acme_items__api_call__backup", "backup", true, [backup1, backup2].sort()],
        ["acme_items__api_call__primary", "primary", true, [primary]],
      ]);
    });

    it("lists no hidden api_call and no auth without a connection", async () => {
      await seedProxyIntegration(ctx, keyManifest("@acme/hidden", { hidden_tools: ["api_call"] }));
      await seedProxyConnection(ctx, "@acme/hidden", "api", { api_key: "a" });
      await seedProxyIntegration(ctx, twoAuthApiIntegrationManifest("@acme/half"));
      await seedProxyConnection(ctx, "@acme/half", "primary", { api_key: "a" });

      const { body } = await list();
      expect(body.tools.map((tool) => [tool.name, tool.connection_required])).toEqual([
        ["acme_half__api_call__primary", false],
      ]);
    });

    it("hashes apart the namespaces of package ids that normalise alike, from each id alone", async () => {
      const ids = ["@acme-items/x", "@acme/items-x"];
      for (const id of ids) {
        await seedProxyIntegration(ctx, keyManifest(id));
        await seedProxyConnection(ctx, id, "api", { api_key: "a" });
      }
      await seedProxyIntegration(ctx, keyManifest("@acme/items"));
      await seedProxyConnection(ctx, "@acme/items", "api", { api_key: "a" });

      const hashed = (id: string) => `acme_items_x_${fnv1a64Hex(id).slice(0, 6)}__api_call`;
      const { body } = await list();
      expect(body.tools.map((tool) => [tool.integration_package_id, tool.name]).sort()).toEqual(
        [
          ["@acme-items/x", hashed("@acme-items/x")],
          ["@acme/items", "acme_items__api_call"],
          ["@acme/items-x", hashed("@acme/items-x")],
        ].sort(),
      );
    });

    it("resolves a tool by its full name, a namespace ending in `_` included", async () => {
      // `acme_crm_suite_tool_` (cut at 20 characters) and `acme_crm_suite_tool`: the second
      // name's namespace and separator start the first's.
      const ids = ["@acme/crm-suite-tool-mail", "@acme/crm-suite-tool"];
      for (const id of ids) {
        await seedProxyIntegration(ctx, keyManifest(id));
        await seedProxyConnection(ctx, id, "api", { api_key: "a" });
      }
      const all = (await list()).body.tools;
      expect(all.map((tool) => [tool.integration_package_id, tool.name])).toEqual([
        ["@acme/crm-suite-tool", "acme_crm_suite_tool__api_call"],
        ["@acme/crm-suite-tool-mail", "acme_crm_suite_tool___api_call"],
      ]);
      for (const tool of all) {
        const { body } = await list({ name: tool.name });
        expect(body.tools.map((t) => [t.name, t.integration_package_id])).toEqual([
          [tool.name, tool.integration_package_id],
        ]);
      }
      expect((await list({ name: "acme_crm_suite_tool__search" })).body.tools).toEqual([]);
    });
  });
});
