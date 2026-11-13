// SPDX-License-Identifier: Apache-2.0

/**
 * `search_integration_tools` and `call_integration_tool` through the real `/api/mcp/o/:org`
 * endpoint, the real
 * credential-proxy routes behind them and a real minted MCP instance token (DCR client,
 * authorization-code flow, `aud` = the organization's MCP resource):
 *
 *   - who is offered the two tools: a space admin, an operator, the owner of a personal space
 *     and a credential holding `credential-proxy:call` or `credential-proxy:call-own`, never a
 *     runner, a credential whose scopes omit both, or a cookie session or the chat's loopback
 *     bearer, which the bearer-only proxy refuses;
 *   - `call_integration_tool` with `{ns}__api_call` makes one proxy call per request and relays what each came back with: the
 *     upstream's answer, cut and filtered, or the proxy's own refusal. A connection another
 *     member shared is reached once named by a holder of `credential-proxy:call`, never with
 *     `credential-proxy:call-own` alone;
 *   - `search_integration_tools` and the catalog's listing operation serve the same rows: the caller's
 *     own, and for a holder of `credential-proxy:call` those shared into the space;
 *   - a remote MCP integration's typed tool (a fake server on loopback) searched, described and
 *     called on both endpoints, an integration nobody connected in `not_ready` with its connect
 *     link, the chat's loopback bearer refused at the routes themselves, and a closed space's
 *     pinned endpoint offering nothing to call.
 *
 * The upstream is a stub of the global `fetch` the proxy calls, as in
 * `test/integration/routes/credential-proxy.test.ts`, which covers the proxy's access rule and
 * what reaches the upstream; argument handling and result shaping are covered request by request
 * in `test/unit/modules/mcp/integration-tools.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { forgetProtocolEras } from "@appstrate/mcp-transport/testing";
import { getEnv } from "@appstrate/env";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { eq, like } from "drizzle-orm";
import { integrationConnections, oauthResource, spaces } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { db, truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  memberContext,
  memberHolding,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import { seedApiKey, seedSpace, seedSpaceMember } from "../../../../../test/helpers/seed.ts";
import { seedShares } from "../../../../../test/helpers/connection-shares.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../../../../test/helpers/credential-proxy-fixtures.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
  remoteIntegrationManifest,
} from "../../../../../test/helpers/integration-manifests.ts";
import {
  startFakeMcpServer,
  type FakeMcpServer,
} from "../../../../../test/helpers/fake-mcp-server.ts";
import { allowLoopbackOAuthEgress } from "../../../../../test/helpers/strict-authorization-server.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { overrideJwks } from "../../../oidc/services/enduser-token.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri } from "../../../../lib/audiences.ts";
import { drainAudits } from "../../../../services/audit.ts";
import { CREDENTIAL_FAILURE_SENTENCES } from "../../../../lib/credential-failure.ts";
import { isValidSessionId } from "../../../../services/credential-proxy/session.ts";
import { resetOidcGuardsLimiters } from "../../../oidc/auth/guards.ts";
import { authorizationCodeFlow } from "../../../oidc/test/helpers/authorization-code-flow.ts";
import mcpModule from "../../index.ts";
// By path, as `test/integration/modules/mcp-read-skill.test.ts` does: the minting secret is
// process-local to the module instance whose auth strategy the app registered.
import { mintMcpLoopbackToken } from "../../../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();
await registerTestPlatformApp();

const INTEGRATION_ID = "@cporg/crm";
const UPSTREAM = "https://1.1.1.1";
const REDIRECT_URI = "http://localhost:9917/callback";
const MCP_SCOPE = "openid mcp:read mcp:invoke";
/** A custom role offered both tools: the transport's two grants and the proxy's permission outside a run. */
const CALL_OWN_ROLE = ["mcp:read", "mcp:invoke", "credential-proxy:call-own"];

// ─── Upstream stub ────────────────────────────────────────
// The proxy reaches its upstream through the global `fetch`. Only calls to the upstream host
// are answered here; anything else goes to the real one, captured once at module load.
const realFetch: typeof fetch = globalThis.fetch;

/** One request the upstream received. */
interface UpstreamCall {
  url: string;
  path: string;
  method: string;
  headers: Headers;
  body: string;
}
type Upstream = (call: UpstreamCall) => Response | Promise<Response>;
let upstreamCalls: UpstreamCall[];

function mockUpstream(answer: Upstream): void {
  upstreamCalls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    if (!url.startsWith(UPSTREAM)) return realFetch(input, init);
    const call: UpstreamCall = {
      url,
      path: new URL(url).pathname,
      method: init?.method ?? request?.method ?? "GET",
      headers: new Headers(init?.headers ?? request?.headers),
      body: await new Response(init?.body ?? null).text(),
    };
    upstreamCalls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

// ─── Callers ──────────────────────────────────────────────

/** An MCP connection: the endpoint it posts to and the credential it carries. */
interface Caller {
  path: string;
  headers: Record<string, string>;
}

const spacePath = (ctx: TestContext, spaceId = ctx.defaultSpaceId) =>
  `/api/mcp/o/${ctx.orgId}/s/${spaceId}`;

/** A real MCP instance token for `ctx.user`, bound to the organization's resource. */
async function mintInstanceToken(ctx: TestContext): Promise<string> {
  const registered = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP client (integration tools)",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect([200, 201]).toContain(registered.status);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const { token } = await authorizationCodeFlow(app, {
    cookie: ctx.cookie,
    clientId,
    redirectUri: REDIRECT_URI,
    scope: MCP_SCOPE,
    resource: getMcpOrgResourceUri(ctx.orgId),
  });
  return String(token.access_token);
}

/** `ctx.user`'s instance token on the endpoint pinned to the default space. */
async function instanceCaller(ctx: TestContext): Promise<Caller> {
  return {
    path: spacePath(ctx),
    headers: { Authorization: `Bearer ${await mintInstanceToken(ctx)}` },
  };
}

/** An API key of `ctx.user` in the default space, carrying `scopes` of what its creator holds. */
async function keyCaller(ctx: TestContext, scopes: string[]): Promise<Caller> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes,
  });
  return {
    path: `/api/mcp/o/${ctx.orgId}`,
    headers: { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId },
  };
}

async function mcp(
  caller: Caller,
  method: string,
  params: Record<string, unknown> = {},
): Promise<JsonRpcEnvelope> {
  const res = await app.request(caller.path, {
    method: "POST",
    headers: { ...caller.headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${method} answered ${res.status}: ${text}`);
  return JSON.parse(text) as JsonRpcEnvelope;
}

interface ListedTool {
  name: string;
  description: string;
  inputSchema: { required?: string[] };
}

async function listTools(caller: Caller): Promise<ListedTool[]> {
  return ((await mcp(caller, "tools/list")).result?.tools as ListedTool[]) ?? [];
}

const toolNames = async (caller: Caller) => (await listTools(caller)).map((tool) => tool.name);

async function callTool(
  caller: Caller,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const envelope = await mcp(caller, "tools/call", { name, arguments: args });
  const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
  if (!content[0]) throw new Error(`no tool result: ${JSON.stringify(envelope)}`);
  return {
    isError: Boolean(envelope.result?.isError),
    data: JSON.parse(content[0].text) as Record<string, unknown>,
  };
}

type Entry = Record<string, unknown> & {
  error?: { code: string; status: number; detail: string };
};
const entries = (data: Record<string, unknown>) => data.results as Entry[];

/** The tool `@cporg/crm` exposes. */
const TOOL = "cporg_crm__api_call";

/** `call_integration_tool` on {@link TOOL}; `space_id` goes to the top level. */
const callApi = (
  caller: Caller,
  { space_id, ...args }: Record<string, unknown>,
): ReturnType<typeof callTool> =>
  callTool(caller, "call_integration_tool", {
    ...(space_id === undefined ? {} : { space_id }),
    tool: TOOL,
    arguments: args,
  });

const get = (path: string, overrides: Record<string, unknown> = {}) => ({
  method: "GET",
  target: `${UPSTREAM}${path}`,
  ...overrides,
});

describe("mcp integration tools", () => {
  /** The organization's owner: preset `admin` in the default space. */
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    // `truncateAll` wipes the signing keys, so every test mints under a new
    // `kid`; drop the cached key set rather than wait out the refetch cooldown.
    overrideJwks(null);
    owner = await createTestContext({ orgSlug: "cporg" });
    // The row the authorization server needs to mint the organization's MCP resource.
    await mcpModule.events!.onOrgCreate!(owner.orgId, owner.user.email);
    await seedProxyIntegration(owner, {
      ...localIntegrationManifest({
        name: INTEGRATION_ID,
        displayName: "CRM",
        description: "CRM integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: [`${UPSTREAM}/**`],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
      }),
      _meta: { "dev.appstrate/api": { auths: { api: {} } } },
    } as IntegrationManifest);
    mockUpstream(() => json({ ok: true }));
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    // The proxy audits and journals off the response path.
    await drainAudits(5_000);
    // `oauth_resources` sits outside `truncateAll`.
    await db
      .delete(oauthResource)
      .where(like(oauthResource.identifier, `${getMcpOrgResourceUri(owner.orgId)}%`));
  });

  /** A connection of `ctx.user` whose credential is `tok-<account>`. */
  const connect = (ctx: TestContext, account: string) =>
    seedProxyConnection(ctx, INTEGRATION_ID, "api", { api_key: `tok-${account}` }, account);

  const upstreamAuth = () => upstreamCalls.map((call) => call.headers.get("authorization"));

  describe("who is offered the tools", () => {
    it("declares both to a space admin and an operator, neither to a runner", async () => {
      for (const preset of ["admin", "operator"] as const) {
        const caller = preset === "admin" ? owner : await memberContext(owner, "member", preset);
        const names = await toolNames(await instanceCaller(caller));
        expect(names, preset).toContain("search_integration_tools");
        expect(names, preset).toContain("call_integration_tool");
      }

      const runner = await toolNames(
        await instanceCaller(await memberContext(owner, "member", "runner")),
      );
      expect(runner).not.toContain("search_integration_tools");
      expect(runner).not.toContain("call_integration_tool");
      // The control: a runner runs agents, which is not what declares the tools.
      expect(runner).toContain("run_and_wait");
    });

    it("declares both to a custom role holding `credential-proxy:call-own`", async () => {
      const names = await toolNames(
        await instanceCaller(await memberHolding(owner, CALL_OWN_ROLE)),
      );
      expect(names).toContain("search_integration_tools");
      expect(names).toContain("call_integration_tool");
    });

    it("declares both to the owner of a personal space, preset `admin` there", async () => {
      const personal = await seedSpace({
        orgId: owner.orgId,
        name: "Perso",
        ownerUserId: owner.user.id,
        visibility: "private",
      });
      const names = await toolNames({
        path: spacePath(owner, personal.id),
        headers: { Authorization: `Bearer ${await mintInstanceToken(owner)}` },
      });
      expect(names).toContain("search_integration_tools");
      expect(names).toContain("call_integration_tool");
      expect(names).toContain("run_and_wait");
    });

    it("declares both to a credential holding either proxy permission, neither to one omitting both", async () => {
      // Same creator, a space admin: only the key's own ceiling differs.
      const without = await toolNames(
        await keyCaller(owner, ["mcp:read", "mcp:invoke", "agents:run", "runs:read"]),
      );
      expect(without).not.toContain("search_integration_tools");
      expect(without).not.toContain("call_integration_tool");
      expect(without).toContain("run_and_wait");

      // A key scoped `credential-proxy:call` alone, which implies `call-own`.
      for (const permission of ["credential-proxy:call-own", "credential-proxy:call"]) {
        const withIt = await toolNames(
          await keyCaller(owner, ["mcp:read", "mcp:invoke", permission]),
        );
        expect(withIt, permission).toContain("search_integration_tools");
        expect(withIt, permission).toContain("call_integration_tool");
      }
    });

    it("declares neither over a cookie session, which the proxy refuses", async () => {
      const names = await toolNames({
        path: spacePath(owner),
        headers: { Cookie: owner.cookie, "X-Org-Id": owner.orgId },
      });
      expect(names).not.toContain("search_integration_tools");
      expect(names).not.toContain("call_integration_tool");
      expect(names).toContain("invoke_operation");
    });

    it("declares neither over the chat's loopback bearer, which the proxy refuses", async () => {
      // The bearer carries the user's resolved permissions: everything that declares the tools
      // to an instance token, on a credential the proxy does not accept.
      const token = mintMcpLoopbackToken({
        userId: owner.user.id,
        email: owner.user.email,
        name: owner.user.name,
        orgId: owner.orgId,
        orgRole: "owner",
        permissions: [...CALL_OWN_ROLE, "credential-proxy:call", "agents:run", "runs:read"],
      });
      const names = await toolNames({
        path: spacePath(owner),
        headers: { Authorization: `Bearer ${token}`, "X-Org-Id": owner.orgId },
      });
      expect(names).not.toContain("search_integration_tools");
      expect(names).not.toContain("call_integration_tool");
      expect(names).toContain("invoke_operation");
      expect(names).toContain("run_and_wait");
    });

    it("declares them per space on the organization's endpoint", async () => {
      const member = await memberHolding(owner, CALL_OWN_ROLE);
      const other = await seedSpace({ orgId: owner.orgId, name: "Atelier", visibility: "closed" });
      // `runner` there: no proxy permission.
      await seedSpaceMember({ spaceId: other.id, userId: member.user.id, presetRole: "runner" });
      await connect(member, "mine");
      const caller: Caller = {
        path: `/api/mcp/o/${owner.orgId}`,
        headers: { Authorization: `Bearer ${await mintInstanceToken(member)}` },
      };

      const apiCall = (await listTools(caller)).find(
        (tool) => tool.name === "call_integration_tool",
      )!;
      expect(apiCall.inputSchema.required).toContain("space_id");
      // Granted in one of the two spaces: the description names it, and only it.
      const availableIn = apiCall.description.slice(
        0,
        apiCall.description.indexOf("Call a tool search_integration_tools"),
      );
      expect(availableIn).toStartWith("Available in: ");
      expect(availableIn).toContain(owner.defaultSpaceId);
      expect(availableIn).not.toContain(other.id);

      const refused = await callApi(caller, {
        space_id: other.id,
        requests: [get("/contacts")],
      });
      expect(refused.isError).toBe(true);
      expect(refused.data).toMatchObject({
        code: "not_granted",
        granted_in: [owner.defaultSpaceId],
      });
      expect(upstreamCalls).toHaveLength(0);

      const served = await callApi(caller, {
        space_id: owner.defaultSpaceId,
        requests: [get("/contacts")],
      });
      expect(entries(served.data)[0]).toMatchObject({ status: 200, body: { ok: true } });
      expect(upstreamAuth()).toEqual(["Bearer tok-mine"]);
    });

    it("declares neither in a space that closes the credential proxy, to the org owner too", async () => {
      const caller = await instanceCaller(owner);
      expect(await toolNames(caller)).toEqual(
        expect.arrayContaining(["search_integration_tools", "call_integration_tool"]),
      );
      await db
        .update(spaces)
        .set({ credentialProxyOpen: false })
        .where(eq(spaces.id, owner.defaultSpaceId));
      const names = await toolNames(caller);
      expect(names).not.toContain("search_integration_tools");
      expect(names).not.toContain("call_integration_tool");
      const getMe = (await listTools(caller)).find((tool) => tool.name === "get_me")!;
      expect(getMe.description).not.toContain("search_integration_tools");
    });

    it("withholds them per space on the organization's endpoint when one space is closed", async () => {
      const closed = await seedSpace({ orgId: owner.orgId, name: "Coffre" });
      await db.update(spaces).set({ credentialProxyOpen: false }).where(eq(spaces.id, closed.id));
      const caller: Caller = {
        path: `/api/mcp/o/${owner.orgId}`,
        headers: { Authorization: `Bearer ${await mintInstanceToken(owner)}` },
      };

      const callIntegrationTool = (await listTools(caller)).find(
        (tool) => tool.name === "call_integration_tool",
      )!;
      const availableIn = callIntegrationTool.description.slice(
        0,
        callIntegrationTool.description.indexOf("Call a tool search_integration_tools"),
      );
      expect(availableIn).toContain(owner.defaultSpaceId);
      expect(availableIn).not.toContain(closed.id);

      const refused = await callApi(caller, {
        space_id: closed.id,
        requests: [get("/contacts")],
      });
      expect(refused.isError).toBe(true);
      expect(refused.data).toMatchObject({
        code: "credential_proxy_closed",
        space: { id: closed.id, name: "Coffre" },
        granted_in: [owner.defaultSpaceId],
      });
      const error = String(refused.data.error);
      expect(error).toContain(`'Coffre' (${closed.id}) closes the credential proxy outside a run`);
      expect(error).not.toContain("role");
      expect(upstreamCalls).toHaveLength(0);
    });
  });

  describe("with a space admin's instance token", () => {
    let caller: Caller;
    let colleague: TestContext;

    beforeEach(async () => {
      caller = await instanceCaller(owner);
      colleague = await memberContext(owner, "member", "builder");
    });

    /** A connection of the colleague's, shared into the space. */
    async function shareColleagueConnection(): Promise<string> {
      const id = await connect(colleague, "theirs");
      await seedShares(id, [owner.defaultSpaceId]);
      return id;
    }

    it("calls the upstream with the connection's credential and returns its answer", async () => {
      await connect(owner, "mine");
      mockUpstream(() => json({ contacts: [{ id: 1 }] }));

      const { isError, data } = await callApi(caller, {
        requests: [get("/contacts?limit=1", { headers: { Accept: "application/json" } })],
      });

      expect(isError).toBe(false);
      expect(isValidSessionId(data.session_id as string)).toBe(true);
      expect(entries(data)).toEqual([
        {
          index: 0,
          status: 200,
          headers: { "content-type": "application/json" },
          body: { contacts: [{ id: 1 }] },
        },
      ]);
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]!.url).toBe(`${UPSTREAM}/contacts?limit=1`);
      expect(upstreamCalls[0]!.headers.get("accept")).toBe("application/json");
      // The connection's credential, never the caller's MCP token.
      expect(upstreamAuth()).toEqual(["Bearer tok-mine"]);
    });

    it("reports the refresh verdict of a 401 the platform could not recover as `credential`", async () => {
      await connect(owner, "mine");
      mockUpstream(() => json({ message: "Bad credentials" }, 401));

      const { data } = await callApi(caller, { requests: [get("/contacts")] });

      expect(entries(data)[0]).toMatchObject({
        status: 401,
        body: { message: "Bad credentials" },
        credential: {
          status: "in_use",
          cause: "unrefreshable",
          detail: CREDENTIAL_FAILURE_SENTENCES.unrefreshable,
          failures: 1,
          max_failures: getEnv().INTEGRATION_REFRESH_MAX_FAILURES,
        },
      });
      // The internal verdict's wording never reaches the entry.
      expect(Object.keys(entries(data)[0]!.credential as object).sort()).toEqual(
        ["cause", "detail", "failures", "max_failures", "status"].sort(),
      );
    });

    it("reports `needs_reconnection` on the 401 that flags the connection", async () => {
      const connectionId = await connect(owner, "mine");
      await db
        .update(integrationConnections)
        .set({ refreshFailureCount: getEnv().INTEGRATION_REFRESH_MAX_FAILURES - 1 })
        .where(eq(integrationConnections.id, connectionId));
      mockUpstream(() => json({ message: "Bad credentials" }, 401));

      const { data } = await callApi(caller, { requests: [get("/contacts")] });

      expect(entries(data)[0]).toMatchObject({ status: 401, body: { message: "Bad credentials" } });
      expect(entries(data)[0]!.credential).toEqual({
        status: "needs_reconnection",
        cause: "unrefreshable",
        detail: CREDENTIAL_FAILURE_SENTENCES.unrefreshable,
      });
      const [row] = await db
        .select({ needsReconnection: integrationConnections.needsReconnection })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connectionId));
      expect(row!.needsReconnection).toBe(true);
    });

    it("carries no `credential` on an upstream answer the platform did not judge", async () => {
      await connect(owner, "mine");
      mockUpstream(() => json({ message: "Forbidden" }, 403));

      const { data } = await callApi(caller, { requests: [get("/contacts")] });

      expect(entries(data)[0]).toMatchObject({ status: 403 });
      expect(entries(data)[0]).not.toHaveProperty("credential");
    });

    it("runs a batch through, one refused request leaving the others their answers", async () => {
      await connect(owner, "mine");
      mockUpstream((call) =>
        call.path === "/missing"
          ? json({ message: "Not Found" }, 404)
          : json({ path: call.path, method: call.method }),
      );

      const { isError, data } = await callApi(caller, {
        requests: [
          get("/a"),
          // Off the integration's `authorized_uris`: the proxy refuses, nothing is sent.
          { method: "GET", target: "https://8.8.8.8/elsewhere" },
          get("/missing"),
          { ...get("/b"), method: "POST", body: { name: "x" } },
        ],
      });

      expect(isError).toBe(false);
      const [a, offList, missing, b] = entries(data);
      expect(a).toMatchObject({ index: 0, status: 200, body: { path: "/a", method: "GET" } });
      expect(offList!.error).toMatchObject({ status: 403, code: "unauthorized_target" });
      expect(offList).not.toHaveProperty("status");
      // The upstream's own refusal is its answer, not the platform's.
      expect(missing).toMatchObject({ index: 2, status: 404, body: { message: "Not Found" } });
      expect(missing).not.toHaveProperty("error");
      expect(b).toMatchObject({ index: 3, status: 200, body: { path: "/b", method: "POST" } });

      expect(upstreamCalls.map((call) => call.path).sort()).toEqual(["/a", "/b", "/missing"]);
      const posted = upstreamCalls.find((call) => call.method === "POST")!;
      expect(posted.headers.get("content-type")).toBe("application/json");
      expect(posted.body).toBe('{"name":"x"}');
    });

    it("cuts each body at `max_response_bytes`, text or not", async () => {
      await connect(owner, "mine");
      mockUpstream((call) =>
        call.path === "/export"
          ? new Response("x".repeat(5000), { headers: { "content-type": "text/plain" } })
          : new Response(new Uint8Array(300), { headers: { "content-type": "image/png" } }),
      );

      const { data } = await callApi(caller, {
        requests: [get("/export"), get("/logo.png")],
        max_response_bytes: 100,
      });

      const [text, image] = entries(data);
      expect(text).toMatchObject({ status: 200, body: "x".repeat(100), truncated: true });
      expect(image).toMatchObject({ status: 200, bytes: 100, truncated: true });
    });

    it("reaches a colleague's shared connection once named; credential-proxy:call-own alone is never offered it", async () => {
      const shared = await shareColleagueConnection();
      const unnamed = get("/contacts");
      const named = get("/contacts", { connection_id: shared });

      // The admin holds `credential-proxy:call`: the fallback binds no share.
      const fallback = await callApi(caller, { requests: [unnamed] });
      expect(entries(fallback.data)[0]!.error).toMatchObject({
        status: 409,
        code: "must_choose_connection",
      });
      expect(upstreamCalls).toHaveLength(0);
      const served = await callApi(caller, { requests: [named] });
      expect(entries(served.data)[0]).toMatchObject({ status: 200, body: { ok: true } });
      expect(upstreamAuth()).toEqual(["Bearer tok-theirs"]);

      // `credential-proxy:call-own` alone, no connection of its own: the tool is not its to call.
      const ownOnly = await instanceCaller(await memberHolding(owner, CALL_OWN_ROLE));
      for (const request of [unnamed, named]) {
        const { isError, data } = await callApi(ownOnly, { requests: [request] });
        expect(isError).toBe(true);
        expect(data).toMatchObject({ code: "unknown_tool" });
      }
      // Holding one of its own, the colleague's is still out of reach, by name or by the proxy.
      const connectedMember = await memberHolding(owner, CALL_OWN_ROLE);
      await connect(connectedMember, "own");
      const ownConnected = await instanceCaller(connectedMember);
      const byName = await callApi(ownConnected, { requests: [named] });
      expect(byName.data).toMatchObject({
        code: "invalid_argument",
        arguments: ["arguments.requests[0].connection_id"],
      });
      expect(upstreamCalls).toHaveLength(1);
    });

    it("keeps a colleague's shared connection from a `credential-proxy:call-own` member at /proxy itself, whatever its credential", async () => {
      const shared = await shareColleagueConnection();
      const member = await memberHolding(owner, CALL_OWN_ROLE);
      await connect(member, "own");
      const memberKey = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: member.user.id,
        scopes: ["credential-proxy:call-own"],
      });
      const proxy = (bearer: string, headers: Record<string, string> = {}) =>
        app.request("/api/credential-proxy/proxy", {
          method: "POST",
          headers: {
            ...headers,
            Authorization: `Bearer ${bearer}`,
            "X-Org-Id": owner.orgId,
            "X-Space-Id": owner.defaultSpaceId,
            "X-Integration-Id": INTEGRATION_ID,
            "X-Target": `${UPSTREAM}/contacts`,
            "X-Session-Id": crypto.randomUUID(),
            "Content-Type": "application/json",
          },
          body: "{}",
        });

      // The member's MCP instance token is bound to the MCP resource (RFC 8707): it reaches
      // /proxy only through call_integration_tool, which offers no connection outside its listing.
      const instance = await proxy(await mintInstanceToken(member), { "X-Connection-Id": shared });
      expect(instance.status).toBe(401);
      expect(instance.headers.get("www-authenticate")).toContain("invalid_token");
      const byTool = await callApi(await instanceCaller(member), {
        requests: [get("/contacts", { connection_id: shared })],
      });
      expect(byTool.data).toMatchObject({ code: "invalid_argument" });
      expect(upstreamCalls).toHaveLength(0);

      // The same member's API key, the credential that does reach the route: its own connection
      // is served, the colleague's named one is the opaque 404 of no connection at all.
      const own = await proxy(memberKey.rawKey);
      expect(own.status).toBe(200);
      expect(upstreamAuth()).toEqual(["Bearer tok-own"]);
      const named = await proxy(memberKey.rawKey, { "X-Connection-Id": shared });
      expect(named.status).toBe(404);
      expect(((await named.json()) as { code: string }).code).toBe("credential_not_found");
      expect(upstreamAuth()).toEqual(["Bearer tok-own"]);
    });

    it("serves the listing operation the same rows as search_integration_tools: shared ones for credential-proxy:call only", async () => {
      /** `[connection_id, owned_by_actor]` of each row, read at both doors. */
      const listedBy = async (asCaller: Caller) => {
        const listed = await callTool(asCaller, "search_integration_tools");
        const invoked = await callTool(asCaller, "invoke_operation", {
          operation_id: "listCredentialProxyConnections",
        });
        expect(invoked.isError).toBe(false);
        const tools = listed.data.tools as Array<{
          tool: string;
          integration: string;
          connections: Array<{ connection_id: string; owned_by_actor: boolean }>;
        }>;
        expect(tools.map((tool) => [tool.tool, tool.integration])).toEqual([
          [TOOL, INTEGRATION_ID],
        ]);
        const rows = tools[0]!.connections;
        // Every field of the listing's rows and the integration carried by the tool; an HTTP
        // call selects no tool, so no `missing_scopes`.
        const listingRows: Record<string, unknown>[] = (
          invoked.data.body as { data: Record<string, unknown>[] }
        ).data;
        const searchRows: Record<string, unknown>[] = rows.map((row) => ({
          integration_package_id: INTEGRATION_ID,
          ...row,
        }));
        expect(listingRows).toEqual(searchRows);
        return rows
          .map((row): [string, boolean] => [row.connection_id, row.owned_by_actor])
          .sort(([a], [b]) => a.localeCompare(b));
      };
      const own = await connect(owner, "mine");
      const shared = await shareColleagueConnection();
      const member = await memberHolding(owner, CALL_OWN_ROLE);
      const members = await connect(member, "members");

      const both: [string, boolean][] = [
        [own, true],
        [shared, false],
      ];
      expect(await listedBy(caller)).toEqual(both.sort(([a], [b]) => a.localeCompare(b)));
      expect(await listedBy(await instanceCaller(member))).toEqual([[members, true]]);
    });
  });
  describe("a remote MCP integration's typed tools, through the endpoint and the routes", () => {
    const REMOTE_ID = "@cporg/docs";
    const REMOTE_TOOL = "cporg_docs__search";
    const NOTES_ID = "@cporg/notes";
    const REMOTE_TOKEN = "tok-remote";
    let server: FakeMcpServer;
    let restoreEgress: () => void;

    beforeAll(() => {
      restoreEgress = allowLoopbackOAuthEgress();
      server = startFakeMcpServer({
        tools: [{ name: "search", description: "Full-text search." }],
        bearer: REMOTE_TOKEN,
      });
    });

    afterAll(() => {
      server.stop();
      restoreEgress();
    });

    beforeEach(async () => {
      forgetProtocolEras();
      server.requests.length = 0;
      const bearerAuth = {
        type: "api_key" as const,
        authorizedUris: [`${server.origin}/**`],
        credentialFields: ["token"],
        requiredCredentialFields: ["token"],
        delivery: {
          http: {
            in: "header" as const,
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.token}",
          },
        },
      };
      await seedProxyIntegration(
        owner,
        remoteIntegrationManifest({
          name: REMOTE_ID,
          url: server.url,
          tools_policy: { search: {} },
          auths: { api_key: bearerAuth },
        }),
      );
      await seedProxyConnection(owner, REMOTE_ID, "api_key", { token: REMOTE_TOKEN });
      // Active here, connected by no one: what a connect link clears (an oauth2 consent screen).
      await seedProxyIntegration(owner, {
        ...remoteIntegrationManifest({
          name: NOTES_ID,
          url: server.url,
          tools_policy: { search: {} },
          auths: {},
        }),
        auths: {
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
      } as unknown as IntegrationManifest);
    });

    /** Search, read the typed tool, call it and read the not-ready integration, through `caller`. */
    async function searchAndCall(caller: Caller, spaceId?: string) {
      const where = spaceId === undefined ? {} : { space_id: spaceId };
      const searched = await callTool(caller, "search_integration_tools", {
        ...where,
        query: "search",
      });
      expect(searched.isError).toBe(false);
      expect(searched.data.best_match).toMatchObject({
        tool: REMOTE_TOOL,
        integration: REMOTE_ID,
        description: `${REMOTE_ID}. Full-text search.`,
        input_schema: { type: "object", properties: {} },
      });
      // `not_ready` is filtered like the tools: searched by its integration.
      const forNotes = await callTool(caller, "search_integration_tools", {
        ...where,
        integration: NOTES_ID,
      });
      const notReady = forNotes.data.not_ready as Array<{
        integration: string;
        proxy_connection: { status: string };
        refusal?: { code: string; connect_url?: string };
      }>;
      expect(notReady).toEqual([
        expect.objectContaining({
          integration: NOTES_ID,
          proxy_connection: { status: "none", imposed: false },
          refusal: expect.objectContaining({ code: "not_connected", auth_key: "oauth" }),
        }),
      ]);
      // The MCP door asks for connect links: the caller holds `integrations:connect`.
      expect(new URL(notReady[0]!.refusal!.connect_url!).pathname).toBe(
        "/api/integrations/connect/start",
      );

      const exchanges = server.requests.length;
      const envelope = await mcp(caller, "tools/call", {
        name: "call_integration_tool",
        arguments: { ...where, tool: REMOTE_TOOL, arguments: { q: "invoices" } },
      });
      const result = envelope.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError ?? false).toBe(false);
      // The server's own result, relayed.
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ q: "invoices" }) }]);
      // Sent with the connection's credential, never the caller's MCP token.
      const sent = server.requests.slice(exchanges);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((r) => r.headers.get("authorization") === `Bearer ${REMOTE_TOKEN}`)).toBe(
        true,
      );
      expect(sent.some((r) => r.body.includes('"tools/call"'))).toBe(true);
    }

    it("searches, describes and calls a typed tool on the endpoint pinned to the space", async () => {
      await searchAndCall(await instanceCaller(owner));
    });

    it("does the same on the organization's endpoint, naming the space with `space_id`", async () => {
      await searchAndCall(
        {
          path: `/api/mcp/o/${owner.orgId}`,
          headers: { Authorization: `Bearer ${await mintInstanceToken(owner)}` },
        },
        owner.defaultSpaceId,
      );
    });

    it("refuses the chat's loopback bearer at the routes themselves, not only at the endpoint", async () => {
      const token = mintMcpLoopbackToken({
        userId: owner.user.id,
        email: owner.user.email,
        name: owner.user.name,
        orgId: owner.orgId,
        orgRole: "owner",
        permissions: [...CALL_OWN_ROLE, "credential-proxy:call"],
      });
      const headers = {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": owner.orgId,
        "X-Space-Id": owner.defaultSpaceId,
      };
      const listed = await app.request("/api/credential-proxy/tools", { headers });
      expect(listed.status).toBe(403);
      expect(((await listed.json()) as { code: string }).code).toBe("forbidden");
      const called = await app.request("/api/credential-proxy/tools/call", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ integration_package_id: REMOTE_ID, name: "search" }),
      });
      expect(called.status).toBe(403);
      expect(((await called.json()) as { code: string }).code).toBe("forbidden");
      expect(server.requests).toEqual([]);
    });

    it("refuses a call on the endpoint pinned to a space that closes the credential proxy, before any exchange", async () => {
      const caller = await instanceCaller(owner);
      await db
        .update(spaces)
        .set({ credentialProxyOpen: false })
        .where(eq(spaces.id, owner.defaultSpaceId));

      const envelope = await mcp(caller, "tools/call", {
        name: "call_integration_tool",
        arguments: { tool: REMOTE_TOOL, arguments: { q: "invoices" } },
      });
      // A closed space declares neither tool on its pinned endpoint, so the call names no tool
      // there (the organization's endpoint answers `credential_proxy_closed` for a `space_id`).
      expect(envelope.result).toBeUndefined();
      expect(envelope.error).toMatchObject({ code: -32602 });
      expect(String(envelope.error?.message)).toContain("Unknown tool: call_integration_tool");
      expect(server.requests).toEqual([]);
    });
  });
});
