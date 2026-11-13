// SPDX-License-Identifier: Apache-2.0
/**
 * The typed tools of a remote integration through `GET /api/credential-proxy/tools` and
 * `POST /api/credential-proxy/tools/call` at the route boundary: a remote
 * integration's MCP server on loopback (reached through the operator's
 * `EGRESS_ALLOW_INTERNAL_HOSTS` opt-in), called through the credential proxy with the caller's
 * connection, outside a run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionCalls,
  integrationConnections,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { fnv1a64Hex } from "@appstrate/afps-shared/mcp-naming";
import { clearAllCachesLocally } from "@appstrate/core/cache";
import { forgetProtocolEras } from "@appstrate/mcp-transport/testing";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { drainAudits } from "../../../src/services/audit.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
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
          _meta: { "dev.appstrate/events": [{ type: "output.emitted" }], kept: true },
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
      oauth: {
        type: "oauth2",
        authorization_endpoint: "https://idp.example.com/authorize",
        token_endpoint: "https://idp.example.com/token",
        authorized_uris: [`${server.origin}/**`],
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
    tools_policy: { search: {}, create: { required_scopes: { oauth: ["write"] } }, forge: {} },
  } as unknown as IntegrationManifest;
};

interface ListedTool {
  name: string;
  kind: string;
  remote_name?: string;
  description: string;
  input_schema?: Record<string, unknown>;
  catalog_unreadable?: true;
  connections: Record<string, unknown>[];
}
interface Listing {
  tools: ListedTool[];
  truncated_catalogs: { integration_package_id: string; max_tools: number }[];
  unlisted: {
    integration_package_id: string;
    refusal: { status: number; code: string; detail: string };
  }[];
}

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

  it("drops the runtime-event channel from the server's result", async () => {
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
    const listed = await getTestApp().request("/api/credential-proxy/tools", { headers });
    expect(listed.status).toBe(403);
  });

  it("refuses the retired `integration_id` field and an unknown query parameter", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const called = await post("call", { integration_id: ID, name: "search" });
    expect(called.status).toBe(400);
    expect((await list({ integration_id: ID })).status).toBe(400);
    expect((await list({ connection_id: "not-a-uuid" })).status).toBe(400);
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
    const called = await post("call", { integration_package_id: ID, name: "search" });
    expect(called.status).toBe(404);
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
    expect(JSON.stringify(await res.json())).not.toContain("connect_url");
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
});
