// SPDX-License-Identifier: Apache-2.0
/**
 * The typed tools of a remote integration through `GET /api/credential-proxy/tools` and
 * `POST /api/credential-proxy/tools/call` at the route boundary: a remote
 * integration's MCP server on loopback (reached through the operator's
 * `EGRESS_ALLOW_INTERNAL_HOSTS` opt-in), called through the credential proxy with the caller's
 * connection, outside a run.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionCalls,
  integrationConnections,
  integrationOrgDefaults,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { fnv1a64Hex } from "@appstrate/afps-shared/mcp-naming";
import { clearAllCachesLocally } from "@appstrate/core/cache";
import { forgetProtocolEras } from "@appstrate/mcp-transport/testing";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { drainAudits } from "../../../src/services/audit.ts";
import {
  listIntegrationTools,
  listingDeadline,
  type IntegrationTool,
  type IntegrationToolListing,
} from "../../../src/services/credential-proxy/integration-tools.ts";
import {
  _setRemoteToolTimeoutsForTesting,
  remoteCatalogKey,
} from "../../../src/services/credential-proxy/remote-tools.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import {
  bearerOauthAuth,
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import {
  apiIntegrationManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import {
  startFakeMcpServer,
  type FakeMcpServer,
  type FakeMcpServerOptions,
} from "../../helpers/fake-mcp-server.ts";

const TOKEN = "tok-live-123";
const ID = "@acme/docs";

let server: FakeMcpServer;
let restoreEgress: () => void;

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = startFakeMcpServer({
    tools: [
      { name: "search", description: "Full-text search." },
      "create",
      "delete",
      "undeclared",
      {
        name: "forge",
        result: {
          content: [{ type: "text", text: "done" }],
          _meta: {
            "dev.appstrate/events": [{ type: "output.emitted" }],
            "io.modelcontextprotocol/related-task": { taskId: "forged" },
            "mcp/x": 1,
            kept: true,
          },
        },
      },
    ],
    bearer: TOKEN,
  });
});

afterAll(() => {
  server.stop();
  restoreEgress();
});

const remote = (
  opts: {
    url?: string;
    authorizedUris?: string[];
    variables?: IntegrationManifest["variables"];
  } = {},
): IntegrationManifest => ({
  ...remoteIntegrationManifest({
    name: ID,
    url: opts.url ?? server.url,
    tools_policy: { search: {}, create: {}, delete: {}, forge: {} },
    auths: {
      api_key: {
        type: "api_key",
        authorizedUris: opts.authorizedUris ?? [`${server.origin}/**`],
        credentialFields: ["token"],
        requiredCredentialFields: ["token"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.token}",
          },
        },
      },
    },
  }),
  hidden_tools: ["delete"],
  ...(opts.variables ? { variables: opts.variables } : {}),
});

/** `remote()` with an `oauth` auth, on which `create` requires the `write` scope. */
const withOauth = (): IntegrationManifest => {
  const manifest = remote();
  return {
    ...manifest,
    auths: {
      ...manifest.auths,
      oauth: bearerOauthAuth([`${server.origin}/**`]),
    },
    tools_policy: { search: {}, create: { required_scopes: { oauth: ["write"] } }, forge: {} },
  } as unknown as IntegrationManifest;
};

/** A listed tool, any of its kind's fields read. */
type ListedTool = IntegrationTool & Partial<Extract<IntegrationTool, { kind: "remote" }>>;
type Listing = Omit<IntegrationToolListing, "tools" | "unlisted"> & {
  tools: ListedTool[];
  unlisted: {
    integration_package_id: string;
    refusal: { status: number; code: string; detail: string; upstream_status?: number };
  }[];
};

describe("the typed tools of a remote MCP integration", () => {
  let ctx: TestContext;
  let apiKey: string;

  /** `GET /api/credential-proxy/tools`, with `query` as its parameters. */
  const list = async (query: Record<string, string> = {}, key = apiKey) => {
    const res = await getTestApp().request(
      `/api/credential-proxy/tools?${new URLSearchParams(query).toString()}`,
      {
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Org-Id": ctx.orgId,
          "X-Space-Id": ctx.defaultSpaceId,
        },
      },
    );
    const body = (await res.json()) as Listing & { code?: string };
    return { status: res.status, body, remote: body.tools?.filter((t) => t.kind === "remote") };
  };

  const post = (
    path: "call",
    body: unknown,
    key = apiKey,
    extraHeaders: Record<string, string> = {},
  ) =>
    getTestApp().request(`/api/credential-proxy/tools/${path}`, {
      method: "POST",
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${key}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    clearAllCachesLocally();
    forgetProtocolEras();
    ctx = await createTestContext({ orgSlug: "acme" });
    apiKey = (
      await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["credential-proxy:call-own"],
      })
    ).rawKey;
    server.requests.length = 0;
  });

  it("lists the catalog's tools, described by the server, less hidden and undeclared ones", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const { status, remote: tools } = await list({ connection_id: connectionId });
    expect(status).toBe(200);
    expect(tools.map((tool) => [tool.name, tool.remote_name])).toEqual([
      ["acme_docs__search", "search"],
      ["acme_docs__create", "create"],
      ["acme_docs__forge", "forge"],
    ]);
    expect(tools[0]).toMatchObject({ description: `${ID}. Full-text search.` });
    expect(tools.some((tool) => tool.catalog_unreadable)).toBe(false);
    expect(server.requests.every((r) => r.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(
      true,
    );
  });

  it("lists the declared names alone when the server cannot be listed", async () => {
    // Authorized, but nothing answers there.
    const closed = "http://127.0.0.1:9/mcp";
    await seedProxyIntegration(
      ctx,
      remote({ url: closed, authorizedUris: ["http://127.0.0.1:9/**"] }),
    );
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const { status, remote: tools } = await list({ connection_id: connectionId });
    expect(status).toBe(200);
    // The declared names (`tools_policy` keys, stored as JSONB: their order is not the author's).
    expect(tools.map((tool) => tool.remote_name).sort()).toEqual(["create", "forge", "search"]);
    for (const tool of tools) {
      expect(tool).toMatchObject({
        description: `${ID}.`,
        input_schema: { type: "object" },
        catalog_unreadable: true,
      });
    }
  });

  it("lists with the connection the proxy selects when none is named", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const { status, remote: tools } = await list();
    expect(status).toBe(200);
    expect(tools[0]).toMatchObject({
      name: "acme_docs__search",
      kind: "remote",
      remote_name: "search",
      description: `${ID}. Full-text search.`,
      input_schema: { type: "object", properties: {} },
    });
  });

  it("lists with the first connection the proxy accepts when several qualify and none is named", async () => {
    await seedProxyIntegration(ctx, remote());
    const first = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "acct-1");
    const second = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "acct-2");

    const { remote: tools, body } = await list();
    expect(body.unlisted).toEqual([]);
    expect(tools.map((tool) => tool.remote_name)).toEqual(["search", "create", "forge"]);
    expect(tools[0]!.connections.map((c) => c.connection_id).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("lists, per connection of a typed tool, the scopes its policy requires that it lacks", async () => {
    await seedProxyIntegration(ctx, withOauth());
    const bare = await seedProxyConnection(ctx, ID, "oauth", { access_token: TOKEN }, "bare");
    const scoped = await seedProxyConnection(ctx, ID, "oauth", { access_token: TOKEN }, "scoped");
    await db
      .update(integrationConnections)
      .set({ scopesGranted: ["write"] })
      .where(eq(integrationConnections.id, scoped));

    const { remote: tools } = await list({ connection_id: bare });
    const create = tools.find((tool) => tool.remote_name === "create")!;
    expect(
      Object.fromEntries(create.connections.map((c) => [c.connection_id, c.missing_scopes])),
    ).toEqual({ [bare]: ["write"], [scoped]: [] });
    const search = tools.find((tool) => tool.remote_name === "search")!;
    expect(
      search.connections.every(
        (c) => Array.isArray(c.missing_scopes) && (c.missing_scopes as string[]).length === 0,
      ),
    ).toBe(true);
  });

  it("journals a listing that reaches the server once, and one served from cache not at all", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    expect((await list()).remote).toHaveLength(3);
    const exchanges = server.requests.length;
    expect((await list()).remote).toHaveLength(3);
    // The cached catalog: no exchange, and so no credential sent.
    expect(server.requests.length).toBe(exchanges);
    await drainAudits(5_000);
    const rows = await db
      .select()
      .from(connectionCalls)
      .where(eq(connectionCalls.connectionId, connectionId));
    expect(rows.map((row) => row.outcome)).toEqual(["200"]);
  });

  /** The outcomes journaled for `connectionId`, once every pending write landed. */
  const journaled = async (connectionId: string) => {
    await drainAudits(5_000);
    const rows = await db
      .select()
      .from(connectionCalls)
      .where(eq(connectionCalls.connectionId, connectionId));
    return rows.map((row) => row.outcome);
  };

  it("lists a server refusing the credential in `unlisted`, journaling its handshake once", async () => {
    await withServer({ tools: ["search"], bearer: "another-token" }, async (other) => {
      await seedProxyIntegration(ctx, on(other, { tools_policy: { search: {} } }));
      const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const { body, remote: tools } = await list();
      expect(tools).toEqual([]);
      expect(
        body.unlisted.map((entry) => [
          entry.integration_package_id,
          entry.refusal.code,
          entry.refusal.upstream_status,
        ]),
      ).toEqual([[ID, "upstream_credential_rejected", 401]]);
      // The credential was sent, and no tools/list ever was.
      expect(other.requests.length).toBeGreaterThan(0);
      expect(other.requests.some((r) => r.body.includes('"tools/list"'))).toBe(false);
      expect(await journaled(connectionId)).toEqual(["401"]);
    });
  });

  it("journals one row for a tool call whose handshake the server refuses", async () => {
    await withServer({ tools: ["search"], bearer: "another-token" }, async (other) => {
      await seedProxyIntegration(ctx, on(other, { tools_policy: { search: {} } }));
      const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const res = await post("call", { integration_package_id: ID, name: "search" });
      expect(res.status).toBe(502);
      expect(other.requests.some((r) => r.body.includes('"tools/call"'))).toBe(false);
      expect(await journaled(connectionId)).toEqual(["401"]);
    });
  });

  it("resolves an `api_call` tool of a remote integration by name without listing its server", async () => {
    await seedProxyIntegration(ctx, {
      ...remote(),
      _meta: { "dev.appstrate/api": { auths: { api_key: {} } } },
    } as IntegrationManifest);
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const { body } = await list({ name: "acme_docs__api_call" });
    expect(body.tools.map((tool) => [tool.name, tool.kind])).toEqual([
      ["acme_docs__api_call", "api_call"],
    ]);
    expect(server.requests).toEqual([]);
    // A typed tool's name lists the server, and only that tool comes back.
    const typed = await list({ name: "acme_docs__search" });
    expect(typed.body.tools.map((tool) => tool.name)).toEqual(["acme_docs__search"]);
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it("lists with the caller's own connection, never a colleague's it names", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const colleague = await memberContext(ctx, "member");
    const colleagueKey = (
      await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: colleague.user.id,
        scopes: ["credential-proxy:call-own"],
      })
    ).rawKey;

    // The owner's listing fills the cache for that connection.
    expect((await list({ connection_id: connectionId })).remote).toHaveLength(3);
    const exchanges = server.requests.length;
    // Holding none of its own, the colleague has nothing to list the server with.
    const warm = await list({ connection_id: connectionId }, colleagueKey);
    expect(warm.status).toBe(200);
    expect(warm.body.tools).toEqual([]);
    expect(warm.body.unlisted).toEqual([]);
    // Holding one, the colleague's listing is read with it, never with the one named.
    const own = await seedProxyConnection(colleague, ID, "api_key", { token: TOKEN }, "acct-2");
    const withOwn = await list({ connection_id: connectionId }, colleagueKey);
    expect(withOwn.remote[0]!.connections.map((c) => c.connection_id)).toEqual([own]);
    expect(server.requests.length).toBeGreaterThan(exchanges);
  });

  it("serves a cached catalog to no caller its selection does not reach", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    expect((await list({ connection_id: connectionId })).remote).toHaveLength(3);
    const exchanges = server.requests.length;
    const colleague = await memberContext(ctx, "member");
    const colleagueKey = (
      await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: colleague.user.id,
        scopes: ["credential-proxy:call-own"],
      })
    ).rawKey;
    const warm = await post(
      "call",
      { integration_package_id: ID, connection_id: connectionId, name: "search" },
      colleagueKey,
    );
    expect(warm.status).toBe(404);
    expect(((await warm.json()) as { code: string }).code).toBe("credential_not_found");
    // Refused by the selection: neither the cache nor the server answered the colleague.
    expect(server.requests.length).toBe(exchanges);
  });

  it("refuses a call the selected connection lacks the tool's scopes for, before any exchange", async () => {
    await seedProxyIntegration(ctx, withOauth());
    const connectionId = await seedProxyConnection(ctx, ID, "oauth", { access_token: TOKEN });

    // Listing selects no tool: the same connection serves it.
    expect((await list()).remote).toHaveLength(3);
    const exchanges = server.requests.length;
    const res = await post("call", { integration_package_id: ID, name: "create", arguments: {} });
    expect(res.status).toBe(409);
    const problem = (await res.json()) as { code: string; errors: Record<string, unknown>[] };
    expect(problem.code).toBe("insufficient_scopes");
    expect(problem.errors[0]).toMatchObject({
      connection_id: connectionId,
      auth_key: "oauth",
      missing_scopes: ["write"],
      required_scopes: ["write"],
      owned_by_actor: true,
      remedy: "upgrade_or_new",
    });
    expect(server.requests.length).toBe(exchanges);
  });

  describe("a connect link on a selection refusal", () => {
    const OFFERS = { "X-Appstrate-Connect-Offers": "1" };
    let connectKey: string;

    beforeEach(async () => {
      connectKey = (
        await seedApiKey({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          createdBy: ctx.user.id,
          scopes: ["credential-proxy:call-own", "integrations:connect"],
        })
      ).rawKey;
      await seedProxyIntegration(ctx, withOauth());
    });

    it("reconnects the caller's own connection, when asked for", async () => {
      const connectionId = await seedProxyConnection(ctx, ID, "oauth", { access_token: TOKEN });
      await db
        .update(integrationConnections)
        .set({ needsReconnection: true })
        .where(eq(integrationConnections.id, connectionId));
      const call = { integration_package_id: ID, name: "search", arguments: {} };

      const offered = await post("call", call, connectKey, OFFERS);
      expect(offered.status).toBe(409);
      const problem = (await offered.json()) as { code: string; errors: Record<string, unknown>[] };
      expect(problem.code).toBe("needs_reconnection");
      expect(problem.errors[0]).toMatchObject({ connection_id: connectionId, auth_key: "oauth" });
      expect(problem.errors[0]!.connect_url).toStartWith("http");

      const bare = (await (await post("call", call, connectKey)).json()) as {
        errors: Record<string, unknown>[];
      };
      expect(bare.errors[0]).not.toHaveProperty("connect_url");
      expect(server.requests).toHaveLength(0);
    });

    it("offers none on insufficient_scopes, whose remedy says what to do", async () => {
      await seedProxyConnection(ctx, ID, "oauth", { access_token: TOKEN });
      const res = await post(
        "call",
        { integration_package_id: ID, name: "create", arguments: {} },
        connectKey,
        OFFERS,
      );
      expect(res.status).toBe(409);
      const problem = (await res.json()) as { code: string; errors: Record<string, unknown>[] };
      expect(problem.code).toBe("insufficient_scopes");
      expect(problem.errors[0]).not.toHaveProperty("connect_url");
    });
  });

  describe("a server URL built from the connection's variables", () => {
    const path = () => server.url.slice(server.origin.length);
    const seedTemplated = () =>
      seedProxyIntegration(
        ctx,
        remote({
          url: `{$variable.base_url}${path()}`,
          authorizedUris: ["{$variable.base_url}/**"],
          variables: {
            schema: {
              type: "object",
              properties: { base_url: { type: "string" } },
              required: ["base_url"],
            },
          },
        }),
      );

    it("is rendered for the selected connection and held to the proxy's egress guard", async () => {
      await seedTemplated();
      const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
      await db
        .update(integrationConnections)
        .set({ variables: { base_url: server.origin } })
        .where(eq(integrationConnections.id, connectionId));

      // The rendered loopback host reaches the proxy, whose guard refuses a host a variable chose.
      const listed = await list();
      expect(listed.status).toBe(200);
      expect(listed.body.unlisted).toEqual([
        {
          integration_package_id: ID,
          refusal: expect.objectContaining({ status: 403, code: "blocked_target" }),
        },
      ]);
      const called = await post("call", {
        integration_package_id: ID,
        name: "search",
        arguments: {},
      });
      expect(called.status).toBe(403);
      for (const problem of [
        listed.body.unlisted[0]!.refusal,
        (await called.json()) as { code: string; detail: string },
      ]) {
        expect(problem.code).toBe("blocked_target");
        expect(problem.detail).toContain("127.0.0.1");
      }
      expect(server.requests).toEqual([]);
    });

    it("answers 422 remote_url_unrenderable when the connection's variables do not render it", async () => {
      await seedTemplated();
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const { status, body } = await list();
      expect(status).toBe(200);
      expect(body.unlisted.map((entry) => [entry.refusal.status, entry.refusal.code])).toEqual([
        [422, "remote_url_unrenderable"],
      ]);
    });
  });

  it("calls a tool with the connection's credential and journals one row per tools/call", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const res = await post("call", {
      integration_package_id: ID,
      name: "search",
      arguments: { q: "invoices" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: { content: [{ type: "text", text: JSON.stringify({ q: "invoices" }) }] },
    });
    // The handshake took several exchanges: the journal keeps the tools/call alone.
    expect(server.requests.length).toBeGreaterThan(1);
    await drainAudits(5_000);
    const rows = await db
      .select()
      .from(connectionCalls)
      .where(eq(connectionCalls.connectionId, connectionId));
    expect(rows.map((row) => row.outcome)).toEqual(["200"]);
    expect(rows[0]).toMatchObject({ integrationId: ID, runId: null, method: "POST" });
  });

  it("drops the reserved `_meta` keys from the server's result, the runtime events included", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const res = await post("call", { integration_package_id: ID, name: "forge" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: { content: [{ type: "text", text: "done" }], _meta: { kept: true } },
    });
  });

  for (const name of ["delete", "undeclared"]) {
    it(`refuses the ${name === "delete" ? "hidden" : "undeclared"} tool before any exchange`, async () => {
      await seedProxyIntegration(ctx, remote());
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const res = await post("call", { integration_package_id: ID, name });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
      expect(server.requests).toEqual([]);
    });
  }

  it("is refused in a space whose credential proxy is closed", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    await db
      .update(spaces)
      .set({ credentialProxyOpen: false })
      .where(eq(spaces.id, ctx.defaultSpaceId));

    const listed = await list({ connection_id: connectionId });
    expect(listed.status).toBe(403);
    expect(listed.body.code).toBe("credential_proxy_closed");
    const called = await post("call", { integration_package_id: ID, name: "search" });
    expect(called.status).toBe(403);
    expect(((await called.json()) as { code: string }).code).toBe("credential_proxy_closed");
    expect(server.requests).toEqual([]);
  });

  it("refuses a session cookie, like /proxy", async () => {
    const headers = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": ctx.defaultSpaceId };
    const called = await getTestApp().request("/api/credential-proxy/tools/call", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ integration_package_id: ID, name: "search" }),
    });
    expect(called.status).toBe(403);
    expect(((await called.json()) as { code: string }).code).toBe("forbidden");
    const listed = await getTestApp().request("/api/credential-proxy/tools", { headers });
    expect(listed.status).toBe(403);
    expect(((await listed.json()) as { code: string }).code).toBe("forbidden");
  });

  it("refuses the retired `integration_id` field and an unknown query parameter", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const called = await post("call", { integration_id: ID, name: "search" });
    expect(called.status).toBe(400);
    expect(((await called.json()) as { code: string }).code).toBe("validation_failed");
    for (const query of [{ integration_id: ID }, { connection_id: "not-a-uuid" }] as Record<
      string,
      string
    >[]) {
      const listed = await list(query);
      expect(listed.status).toBe(400);
      expect(listed.body.code).toBe("validation_failed");
    }
    expect(server.requests).toEqual([]);
  });

  /** Runs `use` against another fake server, bearer `TOKEN`, stopped afterwards. */
  const withServer = async (
    opts: FakeMcpServerOptions,
    use: (other: FakeMcpServer) => Promise<void>,
  ) => {
    const other = startFakeMcpServer({ bearer: TOKEN, ...opts });
    try {
      await use(other);
    } finally {
      other.stop();
    }
  };
  const on = (other: FakeMcpServer, extra: Record<string, unknown> = {}): IntegrationManifest =>
    ({
      ...remote({ url: other.url, authorizedUris: [`${other.origin}/**`] }),
      ...extra,
    }) as IntegrationManifest;

  it("answers 404 for an integration switched off in the space, its catalog cached or not", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    expect((await list({ integration_package_id: ID })).remote).toHaveLength(3);
    const exchanges = server.requests.length;
    await db.update(spacePackages).set({ enabled: false }).where(eq(spacePackages.packageId, ID));

    const listed = await list({ integration_package_id: ID });
    expect(listed.status).toBe(404);
    expect(listed.body.code).toBe("not_found");
    const called = await post("call", { integration_package_id: ID, name: "search" });
    expect(called.status).toBe(404);
    expect(((await called.json()) as { code: string }).code).toBe("not_found");
    // Neither the warm cache nor the server answered.
    expect(server.requests.length).toBe(exchanges);
    // Unfiltered, the listing leaves it out.
    expect((await list()).body.tools).toEqual([]);
  });

  it("offers no connect link for an integration switched off in the space", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    await db
      .update(integrationConnections)
      .set({ needsReconnection: true })
      .where(eq(integrationConnections.id, connectionId));
    await db.update(spacePackages).set({ enabled: false }).where(eq(spacePackages.packageId, ID));
    const connectKey = (
      await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["credential-proxy:call-own", "integrations:connect"],
      })
    ).rawKey;

    const res = await post("call", { integration_package_id: ID, name: "search" }, connectKey, {
      "X-Appstrate-Connect-Offers": "1",
    });
    expect(res.status).toBe(404);
    const problem = (await res.json()) as { code: string };
    expect(problem.code).toBe("not_found");
    expect(JSON.stringify(problem)).not.toContain("connect_url");
  });

  it("reads at most 500 tools of a server and says so, dropping a name longer than MCP's bound", async () => {
    const many = Array.from({ length: 501 }, (_, i) => `t${i}`);
    await withServer(
      { tools: [`x${"y".repeat(200)}`, ...many], pageSize: 100, era: "modern" },
      async (other) => {
        await seedProxyIntegration(ctx, on(other, { allow_undeclared_tools: true }));
        await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

        const { status, body, remote: tools } = await list();
        expect(status).toBe(200);
        expect(tools).toHaveLength(500);
        expect(tools.some((tool) => tool.remote_name!.length > 128)).toBe(false);
        expect(body.truncated_catalogs).toEqual([{ integration_package_id: ID, max_tools: 500 }]);
      },
    );
  });

  it("lists a shared catalog under its own deadline, whoever leaves first", async () => {
    await withServer({ tools: ["search"], delayMs: 150 }, async (other) => {
      await seedProxyIntegration(ctx, on(other, { tools_policy: { search: {} } }));
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
      const request = (signal?: AbortSignal) =>
        getTestApp().request(
          new Request("http://localhost/api/credential-proxy/tools", {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Org-Id": ctx.orgId,
              "X-Space-Id": ctx.defaultSpaceId,
            },
            ...(signal ? { signal } : {}),
          }),
        );
      const leaving = new AbortController();
      const first = Promise.resolve(request(leaving.signal)).catch(() => null);
      const second = request();
      await Bun.sleep(50);
      leaving.abort();
      await first;
      const body = (await (await second).json()) as Listing;
      expect(body.tools.map((tool) => [tool.remote_name, tool.catalog_unreadable])).toEqual([
        ["search", undefined],
      ]);
    });
  });

  it("lists a catalog not read by the listing's deadline as unreadable, and reads it for the next", async () => {
    await withServer({ tools: ["search"], delayMs: 100 }, async (other) => {
      await seedProxyIntegration(ctx, on(other, { tools_policy: { search: {} } }));
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
      const caller = {
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        actor: { type: "user" as const, id: ctx.user.id },
        reach: "own" as const,
        caller: { apiKeyId: null, authMethod: "api_key", requestId: "req_deadline" },
        signal: new AbortController().signal,
        connectOffers: null,
      };

      const late = await listIntegrationTools(caller, {}, AbortSignal.timeout(20));
      expect(late.unlisted).toEqual([]);
      expect(late.tools.map((tool) => [tool.name, "catalog_unreadable" in tool])).toEqual([
        ["acme_docs__search", true],
      ]);
      // The listing left running under its own deadline: the next one shares it, then reads it.
      const next = await listIntegrationTools(caller, {}, listingDeadline());
      expect(next.tools.map((tool) => [tool.name, "catalog_unreadable" in tool])).toEqual([
        ["acme_docs__search", false],
      ]);
      const exchanges = other.requests.length;
      await listIntegrationTools(caller, {}, AbortSignal.timeout(20));
      expect(other.requests.length).toBe(exchanges);
    });
  });

  it("lists and calls the tools of two integrations whose namespaces normalise alike", async () => {
    const outlook = "@appstrate/microsoft-outlook";
    const teams = "@appstrate/microsoft-teams";
    for (const id of [outlook, teams]) {
      await seedProxyIntegration(ctx, { ...remote(), name: id } as IntegrationManifest);
      await seedProxyConnection(ctx, id, "api_key", { token: TOKEN });
    }
    // Both normalise to `appstrate_microsoft_` (its trailing `_` kept): each takes its id's hash.
    const nameOf = (id: string) => `appstrate_microsoft__${fnv1a64Hex(id).slice(0, 6)}__search`;

    const { remote: tools } = await list();
    expect(
      tools
        .filter((tool) => tool.remote_name === "search")
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([nameOf(outlook), nameOf(teams)].sort());
    for (const id of [outlook, teams]) {
      // What call_integration_tool resolves a name with, then calls.
      const resolved = await list({ name: nameOf(id) });
      expect(
        resolved.body.tools.map((t) => [
          t.name,
          (t as { integration_package_id?: string }).integration_package_id,
        ]),
      ).toEqual([[nameOf(id), id]]);
      const res = await post("call", { integration_package_id: id, name: "search", arguments: {} });
      expect(res.status).toBe(200);
    }
  });

  describe("a name resolved while its server cannot be listed", () => {
    const closed = "http://127.0.0.1:9/mcp";
    const unreachable = (extra: Record<string, unknown> = {}) =>
      ({
        ...remote({ url: closed, authorizedUris: ["http://127.0.0.1:9/**"] }),
        ...extra,
      }) as IntegrationManifest;

    it("still names an undeclared tool of an integration allowing them, and calling it says the server failed", async () => {
      await seedProxyIntegration(ctx, unreachable({ allow_undeclared_tools: true }));
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const { body } = await list({ name: "acme_docs__other" });
      expect(body.tools).toEqual([
        expect.objectContaining({
          name: "acme_docs__other",
          remote_name: "other",
          catalog_unreadable: true,
        }),
      ]);
      const res = await post("call", { integration_package_id: ID, name: "other" });
      expect(res.status).toBe(502);
      // Nothing listens there: the proxy's own transport fault, marked as such.
      expect(res.headers.get("proxy-status")).toBe("appstrate; error=destination_unavailable");
      expect(((await res.json()) as { code: string }).code).toBe("upstream_unreachable");
    });

    it("keeps a listing refusal only for a name that may be one of the integration's tools", async () => {
      // A server URL the connection's variables do not render: the proxy refuses to list it.
      await seedProxyIntegration(
        ctx,
        remote({
          url: `{$variable.base_url}/mcp`,
          authorizedUris: ["{$variable.base_url}/**"],
          variables: {
            schema: {
              type: "object",
              properties: { base_url: { type: "string" } },
              required: ["base_url"],
            },
          },
        }),
      );
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const declared = await list({ name: "acme_docs__search" });
      expect(declared.body.unlisted.map((entry) => entry.refusal.code)).toEqual([
        "remote_url_unrenderable",
      ]);
      const wrong = await list({ name: "acme_docs__nope" });
      expect(wrong.body.tools).toEqual([]);
      expect(wrong.body.unlisted).toEqual([]);
    });
  });

  it("says a tool ran but answered past the exchange bound, rather than that it did not answer", async () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    await withServer(
      { tools: [{ name: "search", result: { content: [{ type: "text", text: huge }] } }] },
      async (other) => {
        await seedProxyIntegration(ctx, on(other));
        await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

        const res = await post("call", { integration_package_id: ID, name: "search" });
        expect(res.status).toBe(502);
        const problem = (await res.json()) as { code: string; detail: string };
        expect(problem.code).toBe("upstream_response_too_large");
        expect(problem.detail).toContain("the tool ran");
      },
    );
  });

  it("answers a server's JSON-RPC error with its code and message", async () => {
    await withServer({ tools: ["search"], era: "modern" }, async (other) => {
      await seedProxyIntegration(ctx, on(other, { allow_undeclared_tools: true }));
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const res = await post("call", { integration_package_id: ID, name: "missing" });
      expect(res.status).toBe(502);
      const problem = (await res.json()) as {
        code: string;
        mcp_error: { code: number; message: string };
      };
      expect(problem.code).toBe("upstream_mcp_error");
      expect(problem.mcp_error.code).toBe(-32602);
      expect(problem.mcp_error.message).toContain("Unknown tool");
    });
  });

  describe("deadlines and bounds", () => {
    afterEach(() => _setRemoteToolTimeoutsForTesting());

    it("journals a handshake that never answers once, with its timeout", async () => {
      _setRemoteToolTimeoutsForTesting({ listMs: 150 });
      await withServer({ tools: ["search"], delayMs: 2_000 }, async (other) => {
        await seedProxyIntegration(ctx, on(other, { tools_policy: { search: {} } }));
        const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

        const { remote: tools } = await list();
        expect(tools.map((tool) => [tool.remote_name, tool.catalog_unreadable])).toEqual([
          ["search", true],
        ]);
        expect(await journaled(connectionId)).toEqual(["upstream_timeout"]);
      });
    });

    it("answers 504 upstream_timeout for a tool call past its deadline, journaling the tools/call", async () => {
      _setRemoteToolTimeoutsForTesting({ callMs: 300 });
      await withServer(
        { tools: ["search"], delayMs: 2_000, delayedMethod: "tools/call" },
        async (other) => {
          await seedProxyIntegration(ctx, on(other, { tools_policy: { search: {} } }));
          const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

          const res = await post("call", { integration_package_id: ID, name: "search" });
          expect(res.status).toBe(504);
          expect(res.headers.get("proxy-status")).toBe("appstrate; error=http_response_timeout");
          expect(((await res.json()) as { code: string }).code).toBe("upstream_timeout");
          // The handshake answered 200: the row is the tools/call's.
          expect(await journaled(connectionId)).toEqual(["upstream_timeout"]);
        },
      );
    });

    it("contacts no further server once the listing's wait is over", async () => {
      await withServer({ tools: ["search"], delayMs: 400 }, async (other) => {
        const ids = ["@acme/s1", "@acme/s2", "@acme/s3", "@acme/s4", "@acme/s5", "@acme/s6"];
        for (const id of ids) {
          await seedProxyIntegration(ctx, {
            ...on(other, { tools_policy: { search: {} } }),
            name: id,
          } as IntegrationManifest);
          await seedProxyConnection(ctx, id, "api_key", { token: TOKEN });
        }
        const caller = {
          scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
          actor: { type: "user" as const, id: ctx.user.id },
          reach: "own" as const,
          caller: { apiKeyId: null, authMethod: "api_key", requestId: "req_wait" },
          signal: new AbortController().signal,
          connectOffers: null,
        };

        const listing = await listIntegrationTools(caller, {}, AbortSignal.timeout(30));
        expect(listing.tools).toHaveLength(ids.length);
        await Bun.sleep(100);
        // Each listing in flight sent its first request and waits on it; no other started.
        expect(other.requests.length).toBeLessThanOrEqual(3);
        // Let the listings left running end before the server stops.
        await Bun.sleep(1_500);
      });
    });

    it("says promptly that a tool answered past the exchange bound in an event stream", async () => {
      _setRemoteToolTimeoutsForTesting({ callMs: 20_000 });
      const huge = "x".repeat(3 * 1024 * 1024);
      await withServer(
        {
          tools: [{ name: "search", result: { content: [{ type: "text", text: huge }] } }],
          sse: true,
        },
        async (other) => {
          await seedProxyIntegration(ctx, on(other));
          await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

          const started = Date.now();
          const res = await post("call", { integration_package_id: ID, name: "search" });
          expect(res.status).toBe(502);
          const problem = (await res.json()) as { code: string; detail: string };
          expect(problem.code).toBe("upstream_response_too_large");
          expect(problem.detail).toContain("the tool ran");
          expect(Date.now() - started).toBeLessThan(10_000);
        },
      );
    });
  });

  it("relays a tool's declared output schema in the listing", async () => {
    const outputSchema = {
      type: "object" as const,
      properties: { count: { type: "number" } },
    };
    await withServer({ tools: [{ name: "search", outputSchema }, "create"] }, async (other) => {
      await seedProxyIntegration(ctx, on(other, { tools_policy: { search: {}, create: {} } }));
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const { remote: tools } = await list();
      expect(tools.map((tool) => [tool.remote_name, tool.output_schema])).toEqual([
        ["search", outputSchema],
        ["create", undefined],
      ]);
    });
  });

  it("serves the tool routes with `Cache-Control: no-store`", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const listed = await getTestApp().request("/api/credential-proxy/tools", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
      },
    });
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const called = await post("call", { integration_package_id: ID, name: "search" });
    expect(called.status).toBe(200);
    expect(called.headers.get("cache-control")).toBe("no-store");
    const refused = await post("call", { integration_package_id: ID, name: "delete" });
    expect(refused.status).toBe(404);
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });

  it("never refuses a typed tool with auth_serves_no_selected_tool: every auth serves it", async () => {
    // `api_call` is exposed on `oauth` alone; the caller's only connection is on `api_key`.
    await seedProxyIntegration(ctx, {
      ...withOauth(),
      _meta: { "dev.appstrate/api": { auths: { oauth: {} } } },
    } as IntegrationManifest);
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const res = await post("call", {
      integration_package_id: ID,
      connection_id: connectionId,
      name: "search",
    });
    expect(res.status).toBe(200);
  });

  it("rate-limits the connections listing like the other proxy routes", async () => {
    const res = await getTestApp().request("/api/credential-proxy/connections", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Policy")).toBeTruthy();
  });
  describe("refusals of the tool routes", () => {
    /** An API key of the context user scoped to `scopes`. */
    const keyWith = async (scopes: string[]) =>
      (
        await seedApiKey({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          createdBy: ctx.user.id,
          scopes,
        })
      ).rawKey;
    const problemOf = async (res: Response) =>
      (await res.json()) as {
        code: string;
        detail: string;
        param?: string;
        errors?: Record<string, unknown>[];
      };
    const orgDefault = (connectionIds: string[]) =>
      db.insert(integrationOrgDefaults).values({
        spaceId: ctx.defaultSpaceId,
        integrationId: ID,
        connectionIds,
        enforce: true,
      });

    it("answers 422 integration_not_remote for an integration without a Streamable HTTP server, before any exchange", async () => {
      const httpOnly = "@acme/http";
      await seedProxyIntegration(
        ctx,
        apiIntegrationManifest({
          name: httpOnly,
          apiCall: { authKey: "api" },
          auths: { api: { type: "api_key", authorizedUris: [`${server.origin}/**`] } },
        }),
      );
      await seedProxyConnection(ctx, httpOnly, "api", { api_key: TOKEN });
      const sse = "@acme/sse";
      await seedProxyIntegration(ctx, {
        ...remoteIntegrationManifest({
          name: sse,
          url: server.url,
          transport: "sse",
          tools_policy: { search: {} },
          auths: { api_key: { type: "api_key", authorizedUris: [`${server.origin}/**`] } },
        }),
      } as IntegrationManifest);
      await seedProxyConnection(ctx, sse, "api_key", { api_key: TOKEN });

      for (const id of [httpOnly, sse]) {
        const res = await post("call", { integration_package_id: id, name: "search" });
        expect(res.status).toBe(422);
        expect((await problemOf(res)).code).toBe("integration_not_remote");
      }
      expect(server.requests).toEqual([]);
    });

    it("answers 409 must_choose_connection naming the body's `connection_id` when several connections qualify", async () => {
      await seedProxyIntegration(ctx, remote());
      const first = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "acct-1");
      const second = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "acct-2");

      const res = await post("call", { integration_package_id: ID, name: "search" });
      expect(res.status).toBe(409);
      const problem = await problemOf(res);
      expect(problem.code).toBe("must_choose_connection");
      expect(problem.detail).toContain("`connection_id`");
      expect(problem.detail).not.toContain("X-Connection-Id");
      const candidates = problem.errors![0]!.candidate_connections as { id: string }[];
      expect(candidates.map((c) => c.id).sort()).toEqual([first, second].sort());
      expect(server.requests).toEqual([]);

      const named = await post("call", {
        integration_package_id: ID,
        name: "search",
        connection_id: second,
      });
      expect(named.status).toBe(200);
    });

    it("answers 403 call_permission_required under an enforced org default to `credential-proxy:call-own` alone", async () => {
      await seedProxyIntegration(ctx, remote());
      const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
      await orgDefault([connectionId]);

      for (const named of [undefined, connectionId]) {
        const res = await post("call", {
          integration_package_id: ID,
          name: "search",
          ...(named ? { connection_id: named } : {}),
        });
        expect(res.status).toBe(403);
        expect(res.headers.get("proxy-status")).toBe("appstrate; error=http_request_denied");
        expect((await problemOf(res)).code).toBe("call_permission_required");
      }
      // The listing reads the same refusal: the server is not listed.
      const listed = await list();
      expect(listed.status).toBe(200);
      expect(listed.body.unlisted.map((entry) => entry.refusal.code)).toEqual([
        "call_permission_required",
      ]);
      expect(server.requests).toEqual([]);
    });

    it("answers 400 connection_not_in_org_default for a connection outside an enforced default's set", async () => {
      await seedProxyIntegration(ctx, remote());
      const member = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "in-set");
      const outside = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "outside");
      await orgDefault([member]);
      const callKey = await keyWith(["credential-proxy:call"]);

      const res = await post(
        "call",
        { integration_package_id: ID, name: "search", connection_id: outside },
        callKey,
      );
      expect(res.status).toBe(400);
      const problem = await problemOf(res);
      expect(problem.code).toBe("connection_not_in_org_default");
      expect(problem.param).toBe("connection_id");
      expect(problem.detail).toStartWith("`connection_id` names a connection outside");
      expect(problem.detail).not.toContain("X-Connection-Id");
      expect(server.requests).toEqual([]);
      // The default's member is the call's connection.
      const served = await post("call", { integration_package_id: ID, name: "search" }, callKey);
      expect(served.status).toBe(200);
    });

    it("answers 404 credential_not_found naming the body's `connection_id` for a colleague's connection", async () => {
      await seedProxyIntegration(ctx, remote());
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
      const colleague = await memberContext(ctx, "member");
      const theirs = await seedProxyConnection(colleague, ID, "api_key", { token: TOKEN });

      const res = await post("call", {
        integration_package_id: ID,
        name: "search",
        connection_id: theirs,
      });
      expect(res.status).toBe(404);
      const problem = await problemOf(res);
      expect(problem.code).toBe("credential_not_found");
      expect(problem.param).toBe("connection_id");
      expect(problem.detail).toStartWith("`connection_id` names none of your own connections");
      expect(problem.detail).not.toContain("X-Connection-Id");
      expect(server.requests).toEqual([]);
    });

    it("refuses a body that is not JSON, or not the schema's object, before any exchange", async () => {
      await seedProxyIntegration(ctx, remote());
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
      const raw = await getTestApp().request("/api/credential-proxy/tools/call", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Org-Id": ctx.orgId,
          "X-Space-Id": ctx.defaultSpaceId,
          "Content-Type": "application/json",
        },
        body: '{"integration_package_id": ',
      });
      expect(raw.status).toBe(400);
      expect((await problemOf(raw)).code).toBe("invalid_request");
      for (const body of [
        { integration_package_id: ID, name: "search", arguments: ["q"] },
        { integration_package_id: ID, name: "" },
        { integration_package_id: ID, name: "search", connection_id: "not-a-uuid" },
      ]) {
        const res = await post("call", body);
        expect(res.status).toBe(400);
        expect((await problemOf(res)).code).toBe("validation_failed");
      }
      expect(server.requests).toEqual([]);
    });

    it("answers 502 upstream_credential_rejected when the server refuses the connection's credential", async () => {
      await withServer({ tools: ["search"], bearer: "another-token" }, async (other) => {
        await seedProxyIntegration(ctx, on(other, { tools_policy: { search: {} } }));
        await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

        const res = await post("call", { integration_package_id: ID, name: "search" });
        expect(res.status).toBe(502);
        const problem = (await problemOf(res)) as Awaited<ReturnType<typeof problemOf>> & {
          upstream_status?: number;
        };
        expect(problem.code).toBe("upstream_credential_rejected");
        expect(problem.upstream_status).toBe(401);
        expect(problem.detail).toContain("refused the connection's credential");
        // The credential was sent: the server is the one refusing it.
        expect(other.requests.length).toBeGreaterThan(0);
      });
    });

    it("lists and calls an undeclared tool of an integration allowing them, never a hidden one", async () => {
      await seedProxyIntegration(ctx, { ...remote(), allow_undeclared_tools: true });
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

      const { remote: tools } = await list();
      expect(tools.map((tool) => tool.remote_name)).toEqual([
        "search",
        "create",
        "undeclared",
        "forge",
      ]);
      const res = await post("call", {
        integration_package_id: ID,
        name: "undeclared",
        arguments: { q: "x" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        result: { content: [{ type: "text", text: JSON.stringify({ q: "x" }) }] },
      });
      const exchanges = server.requests.length;
      const hidden = await post("call", { integration_package_id: ID, name: "delete" });
      expect(hidden.status).toBe(404);
      expect((await problemOf(hidden)).code).toBe("not_found");
      expect(server.requests.length).toBe(exchanges);
    });
  });
});

describe("remoteCatalogKey", () => {
  it("tells apart the servers one connection's variables render at the same version", () => {
    // A manifest lets a variable choose the host alone, which the proxy refuses on loopback: the
    // route cannot be driven to two rendered servers here.
    const entry = { orgId: "o", connectionId: "c", integrationId: ID, version: "1.0.0" };
    expect(remoteCatalogKey({ ...entry, url: "https://a.example.com/mcp" })).not.toBe(
      remoteCatalogKey({ ...entry, url: "https://b.example.com/mcp" }),
    );
  });
});
