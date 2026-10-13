// SPDX-License-Identifier: Apache-2.0

/**
 * `list_connections` and `api_call` through the real `/api/mcp/o/:org` endpoint, the real
 * credential-proxy routes behind them and a real minted MCP instance token (DCR client,
 * authorization-code flow, `aud` = the organization's MCP resource):
 *
 *   - who is offered the two tools: a space admin and a custom role holding
 *     `credential-proxy:call-own`, never a builder, the owner of a personal space, a credential
 *     whose scopes omit it, or a cookie session or the chat's loopback bearer, which the
 *     bearer-only proxy refuses;
 *   - `api_call` makes one proxy call per request and relays what each came back with: the
 *     upstream's answer, cut and filtered, or the proxy's own refusal, never reaching a
 *     connection another member shared;
 *   - `list_connections` and the catalog's listing operation serve the same rows, the caller's
 *     own.
 *
 * The upstream is a stub of the global `fetch` the proxy calls, as in
 * `test/integration/routes/credential-proxy.test.ts`, which covers the proxy's access rule and
 * what reaches the upstream; argument handling and result shaping are covered request by request
 * in `test/unit/modules/mcp/connection-tools.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { like } from "drizzle-orm";
import { oauthResource } from "@appstrate/db/schema";
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
} from "../../../../../test/helpers/integration-manifests.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri } from "../../../../lib/audiences.ts";
import { drainAudits } from "../../../../services/audit.ts";
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
      client_name: "MCP client (connection tools)",
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

const get = (path: string, overrides: Record<string, unknown> = {}) => ({
  integration_package_id: INTEGRATION_ID,
  method: "GET",
  target: `${UPSTREAM}${path}`,
  ...overrides,
});

describe("mcp connection tools", () => {
  /** The organization's owner: preset `admin` in the default space. */
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    owner = await createTestContext({ orgSlug: "cporg" });
    // The row the authorization server needs to mint the organization's MCP resource.
    await mcpModule.events!.onOrgCreate!(owner.orgId, owner.user.email);
    await seedProxyIntegration(
      owner,
      localIntegrationManifest({
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
    );
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
    it("declares both to a space admin, neither to a builder", async () => {
      const admin = await toolNames(await instanceCaller(owner));
      expect(admin).toContain("list_connections");
      expect(admin).toContain("api_call");

      const builder = await toolNames(
        await instanceCaller(await memberContext(owner, "member", "builder")),
      );
      expect(builder).not.toContain("list_connections");
      expect(builder).not.toContain("api_call");
      // The control: a builder runs agents and holds `credential-proxy:call-run`, the permission of
      // a proxy call made for a run. Neither is what declares the tools.
      expect(builder).toContain("run_and_wait");
    });

    it("declares both to a custom role holding `credential-proxy:call-own`", async () => {
      const names = await toolNames(
        await instanceCaller(await memberHolding(owner, CALL_OWN_ROLE)),
      );
      expect(names).toContain("list_connections");
      expect(names).toContain("api_call");
    });

    it("declares neither to the owner of a personal space, whose `admin` there omits it", async () => {
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
      expect(names).not.toContain("list_connections");
      expect(names).not.toContain("api_call");
      // The control: the rest of `admin` holds there.
      expect(names).toContain("run_and_wait");
    });

    it("declares neither to a credential whose scopes omit `credential-proxy:call-own`", async () => {
      // Same creator, a space admin: only the key's own ceiling differs.
      const without = await toolNames(
        await keyCaller(owner, [
          "mcp:read",
          "mcp:invoke",
          "credential-proxy:call-run",
          "agents:run",
          "runs:read",
        ]),
      );
      expect(without).not.toContain("list_connections");
      expect(without).not.toContain("api_call");
      expect(without).toContain("run_and_wait");

      const withIt = await toolNames(await keyCaller(owner, CALL_OWN_ROLE));
      expect(withIt).toContain("list_connections");
      expect(withIt).toContain("api_call");
    });

    it("declares neither over a cookie session, which the proxy refuses", async () => {
      const names = await toolNames({
        path: spacePath(owner),
        headers: { Cookie: owner.cookie, "X-Org-Id": owner.orgId },
      });
      expect(names).not.toContain("list_connections");
      expect(names).not.toContain("api_call");
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
        permissions: [...CALL_OWN_ROLE, "credential-proxy:call-run", "agents:run", "runs:read"],
      });
      const names = await toolNames({
        path: spacePath(owner),
        headers: { Authorization: `Bearer ${token}`, "X-Org-Id": owner.orgId },
      });
      expect(names).not.toContain("list_connections");
      expect(names).not.toContain("api_call");
      expect(names).toContain("invoke_operation");
      expect(names).toContain("run_and_wait");
    });

    it("declares them per space on the organization's endpoint", async () => {
      const member = await memberHolding(owner, CALL_OWN_ROLE);
      const other = await seedSpace({ orgId: owner.orgId, name: "Atelier", visibility: "closed" });
      await seedSpaceMember({ spaceId: other.id, userId: member.user.id, presetRole: "builder" });
      await connect(member, "mine");
      const caller: Caller = {
        path: `/api/mcp/o/${owner.orgId}`,
        headers: { Authorization: `Bearer ${await mintInstanceToken(member)}` },
      };

      const apiCall = (await listTools(caller)).find((tool) => tool.name === "api_call")!;
      expect(apiCall.inputSchema.required).toContain("space_id");
      // Granted in one of the two spaces: the description names it, and only it.
      const availableIn = apiCall.description.slice(
        0,
        apiCall.description.indexOf("Call third-party APIs"),
      );
      expect(availableIn).toStartWith("Available in: ");
      expect(availableIn).toContain(owner.defaultSpaceId);
      expect(availableIn).not.toContain(other.id);

      const refused = await callTool(caller, "api_call", {
        space_id: other.id,
        requests: [get("/contacts")],
      });
      expect(refused.isError).toBe(true);
      expect(refused.data).toMatchObject({
        code: "not_granted",
        granted_in: [owner.defaultSpaceId],
      });
      expect(upstreamCalls).toHaveLength(0);

      const served = await callTool(caller, "api_call", {
        space_id: owner.defaultSpaceId,
        requests: [get("/contacts")],
      });
      expect(entries(served.data)[0]).toMatchObject({ status: 200, body: { ok: true } });
      expect(upstreamAuth()).toEqual(["Bearer tok-mine"]);
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

      const { isError, data } = await callTool(caller, "api_call", {
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

    it("runs a batch through, one refused request leaving the others their answers", async () => {
      await connect(owner, "mine");
      mockUpstream((call) =>
        call.path === "/missing"
          ? json({ message: "Not Found" }, 404)
          : json({ path: call.path, method: call.method }),
      );

      const { isError, data } = await callTool(caller, "api_call", {
        requests: [
          get("/a"),
          // Off the integration's `authorized_uris`: the proxy refuses, nothing is sent.
          {
            integration_package_id: INTEGRATION_ID,
            method: "GET",
            target: "https://8.8.8.8/elsewhere",
          },
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

      const { data } = await callTool(caller, "api_call", {
        requests: [get("/export"), get("/logo.png")],
        max_response_bytes: 100,
      });

      const [text, image] = entries(data);
      expect(text).toMatchObject({ status: 200, body: "x".repeat(100), truncated: true });
      expect(image).toMatchObject({ status: 200, bytes: 100, truncated: true });
    });

    it("answers credential_not_found for a colleague's shared connection, named or not", async () => {
      const shared = await shareColleagueConnection();
      for (const request of [get("/contacts"), get("/contacts", { connection_id: shared })]) {
        const { data } = await callTool(caller, "api_call", { requests: [request] });
        expect(entries(data)[0]!.error).toMatchObject({
          status: 404,
          code: "credential_not_found",
        });
      }
      expect(upstreamCalls).toHaveLength(0);
    });

    it("serves the listing operation the same rows as list_connections, the caller's own", async () => {
      const own = await connect(owner, "mine");
      await shareColleagueConnection();

      const listed = await callTool(caller, "list_connections");
      const invoked = await callTool(caller, "invoke_operation", {
        operation_id: "listCredentialProxyConnections",
      });
      expect(invoked.isError).toBe(false);
      const rows = listed.data.connections as Array<{ connection_id: string }>;
      expect((invoked.data.body as { data: unknown[] }).data).toEqual(rows);
      // Never the colleague's shared connection, at either door.
      expect(rows.map((row) => row.connection_id)).toEqual([own]);
    });
  });
});
