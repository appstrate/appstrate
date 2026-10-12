// SPDX-License-Identifier: Apache-2.0

/**
 * `list_connections` and `api_call` through the real `/api/mcp/o/:org` endpoint, the real
 * credential-proxy routes behind them and a real minted MCP instance token (DCR client,
 * authorization-code flow, `aud` = the organization's MCP resource):
 *
 *   - who is offered the two tools: a space admin and a custom role holding
 *     `credential-proxy:direct`, never a builder, a credential whose scopes omit it, or a
 *     cookie session or the chat's loopback bearer, which the bearer-only proxy refuses;
 *   - `list_connections` lists the caller's own connections, as the proxy selects them, and
 *     never a credential value: an allowlist entry that is one stays a template, which
 *     `api_call` targets by placeholder;
 *   - `api_call` makes one proxy call per request and relays what each came back with: the
 *     upstream's answer, cut and filtered, or the proxy's own refusal;
 *   - the operation catalog offers the listing, with the same rows, and never the proxy.
 *
 * The upstream is a stub of the global `fetch` the proxy calls, as in
 * `test/integration/routes/credential-proxy.test.ts`; argument handling and result shaping are
 * covered request by request in `test/unit/modules/mcp/connection-tools.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { like } from "drizzle-orm";
import { integrationOrgDefaults, oauthResource } from "@appstrate/db/schema";
import { isPlatformRequestHeader } from "@appstrate/connect/platform-request-headers";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { db, truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import {
  seedApiKey,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../../../../test/helpers/seed.ts";
import { seedShares } from "../../../../../test/helpers/connection-shares.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../../../../test/helpers/credential-proxy-fixtures.ts";
import {
  envDelivery,
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../../../../test/helpers/integration-manifests.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri } from "../../../../lib/audiences.ts";
import { internalDispatchHeader } from "../../../../lib/internal-dispatch.ts";
import { drainAudits } from "../../../../services/audit.ts";
import { PROXY_CONTROL_HEADERS } from "../../../../services/credential-proxy/control-headers.ts";
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
/** A custom role offered both tools: the transport's two grants and the proxy's direct path. */
const DIRECT_ROLE = ["mcp:read", "mcp:invoke", "credential-proxy:direct"];

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
  error?: { code: string; status: number; detail: string; errors?: unknown[] };
};
const entries = (data: Record<string, unknown>) => data.results as Entry[];

const get = (path: string, overrides: Record<string, unknown> = {}) => ({
  integration_id: INTEGRATION_ID,
  method: "GET",
  target: `${UPSTREAM}${path}`,
  ...overrides,
});

/** A member of `owner`'s org holding exactly `permissions` in its default space. */
async function memberHolding(owner: TestContext, permissions: string[]): Promise<TestContext> {
  const member = await memberContext(owner, "member");
  const role = await seedSpaceRole({ orgId: owner.orgId, permissions });
  await seedSpaceMember({
    spaceId: owner.defaultSpaceId,
    userId: member.user.id,
    presetRole: null,
    customRoleId: role.id,
  });
  return member;
}

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
      // The control: a builder runs agents and holds `credential-proxy:call`, the permission of
      // a proxy call made for a run. Neither is what declares the tools.
      expect(builder).toContain("run_and_wait");
    });

    it("declares both to a custom role holding `credential-proxy:direct`", async () => {
      const names = await toolNames(await instanceCaller(await memberHolding(owner, DIRECT_ROLE)));
      expect(names).toContain("list_connections");
      expect(names).toContain("api_call");
    });

    it("declares neither to a credential whose scopes omit `credential-proxy:direct`", async () => {
      // Same creator, a space admin: only the key's own ceiling differs.
      const without = await toolNames(
        await keyCaller(owner, [
          "mcp:read",
          "mcp:invoke",
          "credential-proxy:call",
          "agents:run",
          "runs:read",
        ]),
      );
      expect(without).not.toContain("list_connections");
      expect(without).not.toContain("api_call");
      expect(without).toContain("run_and_wait");

      const withIt = await toolNames(await keyCaller(owner, DIRECT_ROLE));
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
        permissions: [...DIRECT_ROLE, "credential-proxy:call", "agents:run", "runs:read"],
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
      const member = await memberHolding(owner, DIRECT_ROLE);
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
    async function shareColleagueConnection(account = "theirs"): Promise<string> {
      const id = await connect(colleague, account);
      await seedShares(id, [owner.defaultSpaceId]);
      return id;
    }

    it("lists the caller's own connections only", async () => {
      const own = await connect(owner, "mine");
      await shareColleagueConnection();

      const { isError, data } = await callTool(caller, "list_connections");
      expect(isError).toBe(false);
      expect(data.connections).toEqual([
        {
          integration_id: INTEGRATION_ID,
          connection_id: own,
          label: "mine",
          auth_key: "api",
          scopes_granted: [],
          authorized_uris: [`${UPSTREAM}/**`],
          allow_all_uris: false,
          needs_reconnection: false,
          run_required: false,
        },
      ]);
    });

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

    it("sends the upstream nothing of the platform's own request", async () => {
      // The tool re-enters the proxy with the caller's auth context, the space it entered, the
      // in-process dispatch marker (a per-process secret) and the proxy's controls. The route
      // consumes all of them: the upstream sees the request's own headers and the connection's
      // credential, set under `Authorization` by the integration's delivery.
      await connect(owner, "mine");
      await callTool(caller, "api_call", {
        requests: [get("/contacts", { headers: { Accept: "application/json" } })],
      });

      const { headers } = upstreamCalls[0]!;
      const sent = [...headers.keys()];
      expect(sent).toContain("accept");
      expect(sent).not.toContain(internalDispatchHeader()[0]);
      expect(
        sent.filter(
          (name) =>
            name !== "authorization" &&
            (isPlatformRequestHeader(name) || PROXY_CONTROL_HEADERS.has(name)),
        ),
      ).toEqual([]);
      expect(headers.get("authorization")).toBe("Bearer tok-mine");
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
          { integration_id: INTEGRATION_ID, method: "GET", target: "https://8.8.8.8/elsewhere" },
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

    it("cuts a text body at `max_response_bytes` and omits a non-text one", async () => {
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
      expect(image).toMatchObject({
        status: 200,
        headers: { "content-type": "image/png" },
        note: "Non-text response body omitted.",
        bytes: 100,
        truncated: true,
      });
      expect(image).not.toHaveProperty("body");
    });

    it("relays must_choose_connection with the caller's own candidates, then the one named", async () => {
      const first = await connect(owner, "work");
      const second = await connect(owner, "personal");
      await shareColleagueConnection();

      const ambiguous = await callTool(caller, "api_call", { requests: [get("/contacts")] });
      expect(ambiguous.isError).toBe(true);
      const { error } = entries(ambiguous.data)[0]!;
      expect(error).toMatchObject({ status: 409, code: "must_choose_connection" });
      const candidates = (error!.errors![0] as { candidate_connections: { id: string }[] })
        .candidate_connections;
      // Never the colleague's shared connection.
      expect(candidates.map((candidate) => candidate.id).sort()).toEqual([first, second].sort());
      expect(upstreamCalls).toHaveLength(0);

      const chosen = await callTool(caller, "api_call", {
        requests: [get("/contacts", { connection_id: second })],
      });
      expect(entries(chosen.data)[0]).toMatchObject({ status: 200 });
      expect(upstreamAuth()).toEqual(["Bearer tok-personal"]);
    });

    it("relays run_required under an enforced default, as list_connections announced", async () => {
      const own = await connect(owner, "mine");
      const shared = await shareColleagueConnection();
      await db.insert(integrationOrgDefaults).values({
        spaceId: owner.defaultSpaceId,
        integrationId: INTEGRATION_ID,
        connectionIds: [shared],
        enforce: true,
      });

      const listed = await callTool(caller, "list_connections");
      expect(listed.data.connections).toMatchObject([{ connection_id: own, run_required: true }]);

      const { isError, data } = await callTool(caller, "api_call", {
        requests: [get("/contacts", { connection_id: own })],
      });
      expect(isError).toBe(true);
      expect(entries(data)[0]!.error).toMatchObject({ status: 403, code: "run_required" });
      expect(upstreamCalls).toHaveLength(0);
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

    it("lets no request header stand in for a proxy control or the caller's credential", async () => {
      await connect(owner, "mine");
      const shared = await shareColleagueConnection();
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: colleague.user.id,
        scopes: DIRECT_ROLE,
      });

      for (const [name, value] of [
        ["X-Connection-Id", shared],
        ["X-Run-Id", "run_forged"],
        ["X-Target", `${UPSTREAM}/admin`],
        ["X-Stream-Response", "1"],
        ["Authorization", `Bearer ${key.rawKey}`],
        ["X-Space-Id", "spc_forged"],
      ] as const) {
        const { isError, data } = await callTool(caller, "api_call", {
          requests: [get("/contacts", { headers: { [name]: value } })],
        });
        expect({ name, isError, code: data.code, arguments: data.arguments }).toEqual({
          name,
          isError: true,
          code: "invalid_argument",
          arguments: [`requests[0].headers.${name}`],
        });
      }
      expect(upstreamCalls).toHaveLength(0);
    });

    it("keeps upstream cookies in the session it returns, and never hands them over", async () => {
      await connect(owner, "mine");
      mockUpstream(
        () =>
          new Response("{}", {
            headers: { "content-type": "application/json", "Set-Cookie": "sid=one; Path=/" },
          }),
      );
      const cookieSent = () => upstreamCalls.at(-1)!.headers.get("cookie");

      const first = await callTool(caller, "api_call", { requests: [get("/login")] });
      const sessionId = first.data.session_id as string;
      expect(isValidSessionId(sessionId)).toBe(true);
      expect(JSON.stringify(first.data)).not.toContain("sid=one");
      expect(cookieSent()).toBeNull();

      const continued = await callTool(caller, "api_call", {
        requests: [get("/cart")],
        session_id: sessionId,
      });
      expect(continued.data.session_id).toBe(sessionId);
      expect(cookieSent()).toBe("sid=one");

      // A call naming no session starts its own: the jar does not follow the caller.
      const fresh = await callTool(caller, "api_call", { requests: [get("/cart")] });
      expect(fresh.data.session_id).not.toBe(sessionId);
      expect(cookieSent()).toBeNull();
    });

    it("serves the listing operation the same rows, with no credential value in either", async () => {
      // The allowlist of this auth IS a credential field: the connection's own endpoint, whose
      // path and query are the secret.
      const HOOKS = "@cporg/hooks";
      const HOOK_SECRET = "whk-live-9f2c";
      const hookUrl = `${UPSTREAM}/hooks/T0PRIVATE?key=${HOOK_SECRET}`;
      await seedProxyIntegration(
        owner,
        localIntegrationManifest({
          name: HOOKS,
          displayName: "Hooks",
          description: "Hooks integration",
          auths: {
            api: {
              type: "custom",
              authorizedUris: ["{$credential.webhook_url}"],
              allowAllUris: false,
              credentialFields: ["webhook_url"],
              requiredCredentialFields: ["webhook_url"],
              delivery: envDelivery({ WEBHOOK_URL: "webhook_url" }),
            },
          },
        }),
      );
      await seedProxyConnection(owner, HOOKS, "api", { webhook_url: hookUrl }, "hook");
      await connect(owner, "mine");

      const listed = await callTool(caller, "list_connections");
      const invoked = await callTool(caller, "invoke_operation", {
        operation_id: "listCredentialProxyConnections",
      });
      expect(invoked.isError).toBe(false);
      const rows = listed.data.connections as Array<Record<string, unknown>>;
      expect((invoked.data.body as { data: unknown[] }).data).toEqual(rows);
      expect(rows.map((row) => [row.integration_id, row.authorized_uris])).toEqual([
        [INTEGRATION_ID, [`${UPSTREAM}/**`]],
        [HOOKS, ["{$credential.webhook_url}"]],
      ]);
      for (const payload of [listed.data, invoked.data]) {
        const text = JSON.stringify(payload);
        expect(text).not.toContain(HOOK_SECRET);
        expect(text).not.toContain("T0PRIVATE");
      }

      // The placeholder is what a call writes: the proxy resolves it, the result never holds it.
      const called = await callTool(caller, "api_call", {
        requests: [{ integration_id: HOOKS, method: "POST", target: "{{webhook_url}}", body: {} }],
      });
      expect(entries(called.data)[0]).toMatchObject({ status: 200, body: { ok: true } });
      expect(upstreamCalls.map((call) => call.url)).toEqual([hookUrl]);
      expect(JSON.stringify(called.data)).not.toContain(HOOK_SECRET);
    });

    it("offers the proxy route through no catalog operation", async () => {
      for (const tool of ["describe_operation", "invoke_operation"]) {
        const { isError, data } = await callTool(caller, tool, {
          operation_id: "credentialProxyGet",
        });
        expect({ tool, isError, code: data.code }).toEqual({
          tool,
          isError: true,
          code: "unknown_operation",
        });
      }
      const found = await callTool(caller, "search_operations", { query: "credential proxy" });
      expect(JSON.stringify(found.data)).not.toContain("credentialProxy");
      const instructions = (
        await mcp(caller, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "connection-tools-test", version: "0" },
        })
      ).result?.instructions as string;
      expect(instructions).not.toContain("credentialProxy");
    });
  });
});
