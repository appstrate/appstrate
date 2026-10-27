// SPDX-License-Identifier: Apache-2.0

/**
 * A space-pinned MCP endpoint (`/api/mcp/o/:org/s/:space`) is its own OAuth
 * protected resource, end to end over the real app and real tokens:
 *
 *   - discovery, in both RFC 9728 §3.3 modes (the `resource_metadata` of a 401
 *     challenge, and the path-insertion URL a client builds from the endpoint)
 *     reads back `resource` = the endpoint itself;
 *   - the AS mints a space's resource only for a space of that org, writing its
 *     `oauth_resources` row the first time it is asked;
 *   - a space-bound token reaches its space and nothing else, capped like a
 *     space API key, while an org-bound token reaches the org endpoint and
 *     every space endpoint with the user's organization authority;
 *   - a refresh keeps a space resource while the space lives.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { decodeJwt } from "jose";
import { eq, like, or } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { oauthResource, organizations, spaces } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { db, truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import { seedSpace, seedSpaceMember } from "../../../../../test/helpers/seed.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri, getMcpSpaceResourceUri } from "../../../../lib/audiences.ts";
import { resetOidcGuardsLimiters } from "../../../oidc/auth/guards.ts";
import { authorizationCodeFlow } from "../../../oidc/test/helpers/authorization-code-flow.ts";
import { reconcileMcpAudiences } from "../../oauth-resources.ts";
import mcpModule from "../../index.ts";

const app = getTestApp();
await registerTestPlatformApp();
const BASE = getEnv().APP_URL.replace(/\/+$/, "");
const PRM_PREFIX = "/.well-known/oauth-protected-resource";
const REDIRECT_URI = "http://localhost:9917/callback";
const MCP_SCOPE = "openid mcp:read mcp:invoke";

const orgPath = (org: string) => `/api/mcp/o/${org}`;
const spacePath = (org: string, space: string) => `${orgPath(org)}/s/${space}`;

async function registerClient(): Promise<string> {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP client (space resource)",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect([200, 201]).toContain(res.status);
  return String(((await res.json()) as { client_id: string }).client_id);
}

/**
 * An anonymous `/oauth2/authorize`: the resource gate answers before any
 * session lookup, so a rejected resource bounces to `redirect_uri?error=…` and
 * an accepted one carries on to the login page.
 */
async function authorizeFor(clientId: string, resource: string) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: MCP_SCOPE,
    state: "s",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
    resource,
  });
  const res = await app.request(`/api/auth/oauth2/authorize?${query}`);
  const location = res.headers.get("location");
  if (!location) return { status: res.status };
  const target = new URL(location, REDIRECT_URI);
  return {
    status: res.status,
    pathname: target.pathname,
    error: target.searchParams.get("error") ?? undefined,
  };
}

async function rowExists(identifier: string): Promise<boolean> {
  const rows = await db
    .select({ id: oauthResource.id })
    .from(oauthResource)
    .where(eq(oauthResource.identifier, identifier));
  return rows.length > 0;
}

async function mcpInitialize(path: string, token?: string): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: MCP_ACCEPT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "space-resource-test", version: "0" },
      },
    }),
  });
}

async function mcpToolCall(
  path: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: MCP_ACCEPT,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  return { status: res.status, envelope: text ? (JSON.parse(text) as JsonRpcEnvelope) : {} };
}

function isErrorResult(envelope: JsonRpcEnvelope): boolean {
  return envelope.result?.isError === true;
}

function resultPayload(envelope: JsonRpcEnvelope): Record<string, unknown> {
  const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
  return content[0] ? (JSON.parse(content[0].text) as Record<string, unknown>) : {};
}

/** The `resource_metadata` URL a 401 points the client at. */
function challengedMetadata(res: Response): string | undefined {
  const header = res.headers.get("www-authenticate") ?? "";
  return /resource_metadata="([^"]+)"/.exec(header)?.[1];
}

describe("space-pinned MCP endpoint as its own protected resource", () => {
  let ctx: TestContext;
  let s1: string;
  let s2: string;
  let foreignSpace: string;
  let otherOrgId: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    ctx = await createTestContext();
    s1 = (await seedSpace({ orgId: ctx.orgId, name: "S1", visibility: "closed" })).id;
    s2 = (await seedSpace({ orgId: ctx.orgId, name: "S2", visibility: "closed" })).id;
    await seedSpaceMember({ spaceId: s1, userId: ctx.user.id, presetRole: "admin" });
    await seedSpaceMember({ spaceId: s2, userId: ctx.user.id, presetRole: "admin" });
    const other = await createTestContext();
    otherOrgId = other.orgId;
    foreignSpace = (await seedSpace({ orgId: otherOrgId, name: "T", visibility: "closed" })).id;
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
  });

  // `oauth_resources` sits outside `truncateAll`: drop every row this file's
  // orgs wrote.
  afterEach(async () => {
    await db
      .delete(oauthResource)
      .where(
        or(
          like(oauthResource.identifier, `${getMcpOrgResourceUri(ctx.orgId)}%`),
          like(oauthResource.identifier, `${getMcpOrgResourceUri(otherOrgId)}%`),
        ),
      );
  });

  describe("discovery (RFC 9728 §3.3)", () => {
    it("challenge mode: the 401's resource_metadata describes the space endpoint", async () => {
      const endpoint = `${BASE}${spacePath(ctx.orgId, s1)}`;
      const res = await mcpInitialize(spacePath(ctx.orgId, s1));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        `resource_metadata="${BASE}${PRM_PREFIX}/api/mcp/o/${ctx.orgId}/s/${s1}"`,
      );

      const metadataUrl = new URL(challengedMetadata(res)!);
      const prm = await app.request(metadataUrl.pathname);
      expect(prm.status).toBe(200);
      expect(((await prm.json()) as { resource: string }).resource).toBe(endpoint);
    });

    it("path-insertion mode: the metadata built from the endpoint names that endpoint", async () => {
      const endpoint = `${BASE}${spacePath(ctx.orgId, s1)}`;
      const prm = await app.request(`${PRM_PREFIX}${new URL(endpoint).pathname}`);
      expect(prm.status).toBe(200);
      const body = (await prm.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource).toBe(endpoint);
      expect(body.authorization_servers[0]!.endsWith("/api/auth")).toBe(true);
    });

    it("answers 404 for a malformed space segment", async () => {
      const prm = await app.request(`${PRM_PREFIX}/api/mcp/o/${ctx.orgId}/s/not-a-space`);
      expect(prm.status).toBe(404);
    });
  });

  describe("AS gate", () => {
    it("writes a live space's row on first ask and lets the request through", async () => {
      const clientId = await registerClient();
      const uri = getMcpSpaceResourceUri(ctx.orgId, s1);
      expect(await rowExists(uri)).toBe(false);
      expect(await authorizeFor(clientId, uri)).toMatchObject({
        pathname: "/api/oauth/login",
        error: undefined,
      });
      expect(await rowExists(uri)).toBe(true);
    });

    it("refuses a space of another organization with invalid_target, writing nothing", async () => {
      const clientId = await registerClient();
      const uri = getMcpSpaceResourceUri(ctx.orgId, foreignSpace);
      expect((await authorizeFor(clientId, uri)).error).toBe("invalid_target");
      expect(await rowExists(uri)).toBe(false);
    });

    it("refuses a space that does not exist with invalid_target", async () => {
      const clientId = await registerClient();
      const uri = getMcpSpaceResourceUri(ctx.orgId, `spc_${crypto.randomUUID()}`);
      expect((await authorizeFor(clientId, uri)).error).toBe("invalid_target");
      expect(await rowExists(uri)).toBe(false);
    });
  });

  describe("audience truth table with minted tokens", () => {
    async function mint(resource: string, cookie = ctx.cookie) {
      const clientId = await registerClient();
      return authorizationCodeFlow(app, {
        cookie,
        clientId,
        redirectUri: REDIRECT_URI,
        scope: MCP_SCOPE,
        resource,
      });
    }

    it("a space-bound token reaches its space and nothing else", async () => {
      const spaceUri = getMcpSpaceResourceUri(ctx.orgId, s1);
      const { token, claims } = await mint(spaceUri);
      expect([claims.aud].flat()).toContain(spaceUri);
      const bearer = String(token.access_token);

      expect((await mcpInitialize(spacePath(ctx.orgId, s1), bearer)).status).toBe(200);

      const onOrg = await mcpInitialize(orgPath(ctx.orgId), bearer);
      expect(onOrg.status).toBe(401);
      expect(challengedMetadata(onOrg)).toBe(`${BASE}${PRM_PREFIX}/api/mcp/o/${ctx.orgId}`);

      const onS2 = await mcpInitialize(spacePath(ctx.orgId, s2), bearer);
      expect(onS2.status).toBe(401);
      expect(challengedMetadata(onS2)).toBe(`${BASE}${PRM_PREFIX}/api/mcp/o/${ctx.orgId}/s/${s2}`);

      // Through the in-process dispatch the token is pinned to S1: another
      // space's REST route refuses it.
      const { status, envelope } = await mcpToolCall(
        spacePath(ctx.orgId, s1),
        bearer,
        "invoke_operation",
        { operation_id: "getSpace", path_params: { id: s2 } },
      );
      expect(status).toBe(200);
      expect(resultPayload(envelope).status).toBe(403);

      // Replayed directly on a REST route, the resource-bound token is refused.
      const rest = await app.request("/api/agents", {
        headers: { Authorization: `Bearer ${bearer}`, "X-Org-Id": ctx.orgId, "X-Space-Id": s1 },
      });
      expect(rest.status).toBe(401);
    });

    it("caps a space-bound token like a space API key: org-level operations refused", async () => {
      const { token } = await mint(getMcpSpaceResourceUri(ctx.orgId, s1));
      const bearer = String(token.access_token);

      // Org settings: the user owns the org, the space-bound token does not carry it.
      const rename = await mcpToolCall(spacePath(ctx.orgId, s1), bearer, "invoke_operation", {
        operation_id: "updateOrganization",
        path_params: { orgId: ctx.orgId },
        body: { name: "Renamed through a space token" },
      });
      expect(rename.status).toBe(200);
      expect(isErrorResult(rename.envelope)).toBe(true);
      const refusal = resultPayload(rename.envelope);
      expect(refusal).toMatchObject({ code: "not_granted", status: 403 });
      expect(refusal.required_permissions).toContain("org:update");
      expect(typeof refusal.error).toBe("string");
      expect(typeof refusal.hint).toBe("string");

      // Member management: same cap.
      const invite = await mcpToolCall(spacePath(ctx.orgId, s1), bearer, "invoke_operation", {
        operation_id: "inviteMember",
        path_params: { orgId: ctx.orgId },
        body: { email: "invitee@example.com", role: "member" },
      });
      expect(isErrorResult(invite.envelope)).toBe(true);
      expect(resultPayload(invite.envelope)).toMatchObject({ code: "not_granted", status: 403 });

      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId));
      expect(org!.name).not.toBe("Renamed through a space token");

      // A space-level operation in its own space still works.
      const agents = await mcpToolCall(spacePath(ctx.orgId, s1), bearer, "invoke_operation", {
        operation_id: "listAgents",
      });
      expect(isErrorResult(agents.envelope)).toBe(false);
      expect(resultPayload(agents.envelope).status).toBe(200);
    });

    it("an org-bound token on the same space endpoint keeps the org-level operation", async () => {
      const { token } = await mint(getMcpOrgResourceUri(ctx.orgId));
      const bearer = String(token.access_token);

      const rename = await mcpToolCall(spacePath(ctx.orgId, s1), bearer, "invoke_operation", {
        operation_id: "updateOrganization",
        path_params: { orgId: ctx.orgId },
        body: { name: "Renamed through an org token" },
      });
      expect(isErrorResult(rename.envelope)).toBe(false);
      expect(resultPayload(rename.envelope).status).toBe(200);
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId));
      expect(org!.name).toBe("Renamed through an org token");
    });

    it("a token minted for a closed space the user is not in is refused with not_a_space_member", async () => {
      const member = await memberContext(ctx, "member");
      const { token } = await mint(getMcpSpaceResourceUri(ctx.orgId, s1), member.cookie);

      const res = await mcpInitialize(spacePath(ctx.orgId, s1), String(token.access_token));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("not_a_space_member");
    });

    it("a token minted for a private space the user is not in finds no space", async () => {
      const member = await memberContext(ctx, "member");
      const priv = (await seedSpace({ orgId: ctx.orgId, name: "P", visibility: "private" })).id;
      const { token } = await mint(getMcpSpaceResourceUri(ctx.orgId, priv), member.cookie);

      const res = await mcpInitialize(spacePath(ctx.orgId, priv), String(token.access_token));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { detail: string }).detail).toBe(
        `Space '${priv}' not found in this organization`,
      );
    });

    it("an org-bound token reaches the org endpoint and its space endpoints", async () => {
      const orgUri = getMcpOrgResourceUri(ctx.orgId);
      const { token, claims } = await mint(orgUri);
      expect([claims.aud].flat()).toContain(orgUri);
      const bearer = String(token.access_token);

      expect((await mcpInitialize(spacePath(ctx.orgId, s1), bearer)).status).toBe(200);
      expect((await mcpInitialize(orgPath(ctx.orgId), bearer)).status).toBe(200);
    });
  });

  describe("refresh_token grant with a space resource", () => {
    async function refresh(clientId: string, refreshToken: string, resource: string) {
      const res = await app.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          resource,
        }).toString(),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    it("refreshes while the space lives, and answers invalid_target once it is gone", async () => {
      const clientId = await registerClient();
      const spaceUri = getMcpSpaceResourceUri(ctx.orgId, s2);
      const { token } = await authorizationCodeFlow(app, {
        cookie: ctx.cookie,
        clientId,
        redirectUri: REDIRECT_URI,
        scope: `${MCP_SCOPE} offline_access`,
        resource: spaceUri,
      });
      expect(typeof token.refresh_token).toBe("string");

      const live = await refresh(clientId, String(token.refresh_token), spaceUri);
      expect(live.status).toBe(200);
      const refreshed = live.body;
      expect([decodeJwt(String(refreshed.access_token)).aud].flat()).toContain(spaceUri);
      expect(
        (await mcpInitialize(spacePath(ctx.orgId, s2), String(refreshed.access_token))).status,
      ).toBe(200);

      await db.delete(spaces).where(eq(spaces.id, s2));
      await reconcileMcpAudiences();
      expect(await rowExists(spaceUri)).toBe(false);

      const gone = await refresh(clientId, String(refreshed.refresh_token), spaceUri);
      expect(gone.status).toBe(400);
      expect(gone.body.error).toBe("invalid_target");
      expect(await rowExists(spaceUri)).toBe(false);
    });
  });
});
