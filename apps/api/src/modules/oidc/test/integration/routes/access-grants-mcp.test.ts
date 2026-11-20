// SPDX-License-Identifier: Apache-2.0

/**
 * The access-grants endpoints, on their MCP half, over the real app and real
 * minted tokens:
 *
 *   GET    /api/auth/access-grants               the caller's grants
 *   POST   /api/auth/access-grants/revoke        end one
 *   POST   /api/auth/access-grants/revoke-all    end every one
 *   GET    /api/orgs/:orgId/access-grants        the grants reaching an org (admin)
 *   DELETE /api/orgs/:orgId/access-grants/:id    end one (admin)
 *
 * An MCP grant is (user, OAuth client, MCP endpoint). Ending it must cut the
 * client off on its next request (its access token is a JWT the platform does
 * not look up), and must send the next authorization back through the consent
 * screen.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { auditEvents, oauthRefreshToken, oauthResource } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { db, truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  createTestOrg,
  memberContext,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import {
  seedApiKey,
  seedInvitation,
  seedSpace,
  seedSpaceMember,
} from "../../../../../../test/helpers/seed.ts";
import { deleteSpace, ensurePersonalSpaceFor } from "../../../../../services/spaces.ts";
import { MCP_ACCEPT } from "../../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri, getMcpSpaceResourceUri } from "../../../../../lib/audiences.ts";
import { overrideJwks } from "../../../services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import {
  authorizationCodeFlow,
  authorizeCode,
  exchangeCode,
} from "../../helpers/authorization-code-flow.ts";
import mcpModule from "../../../../mcp/index.ts";

const app = getTestApp();
await registerTestPlatformApp();
const REDIRECT_URI = "https://claude.example.test/oauth/callback";
const SCOPE = "openid offline_access mcp:read mcp:invoke";

interface GrantRow {
  id: string;
  kind: "cli" | "mcp";
  client_name: string | null;
  client_origin: string | null;
  client_registration: string | null;
  last_used_ip: string | null;
  target: {
    orgId: string;
    org_name: string | null;
    spaceId: string | null;
    space_name: string | null;
  } | null;
  session_count: number;
  lastUsedAt: string | null;
  createdAt: string;
  user?: { id: string; email: string | null };
  revocable?: boolean;
}

async function registerClient(name = "Claude Code"): Promise<string> {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect([200, 201]).toContain(res.status);
  return String(((await res.json()) as { client_id: string }).client_id);
}

function mcpInitialize(path: string, token: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: MCP_ACCEPT,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "access-grants-test", version: "0" },
      },
    }),
  });
}

async function myGrants(cookie: string): Promise<GrantRow[]> {
  const res = await app.request("/api/auth/access-grants", { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: GrantRow[] }).data;
}

async function orgGrants(cookie: string, orgId: string): Promise<GrantRow[]> {
  const res = await app.request(`/api/orgs/${orgId}/access-grants`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: GrantRow[] }).data;
}

function refresh(clientId: string, refreshToken: string, resource: string) {
  return app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource,
    }).toString(),
  });
}

/** RFC 7009 revocation of a refresh token by the client itself. */
function revokeRefreshToken(clientId: string, token: string) {
  return app.request("/api/auth/oauth2/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      token_type_hint: "refresh_token",
      client_id: clientId,
    }).toString(),
  });
}

function revokeMine(cookie: string, id: string) {
  return app.request("/api/auth/access-grants/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ id }),
  });
}

describe("MCP access grants", () => {
  let ctx: TestContext;
  let orgResource: string;
  let orgPath: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    ctx = await createTestContext({ orgName: "Acme" });
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    orgResource = getMcpOrgResourceUri(ctx.orgId);
    orgPath = `/api/mcp/o/${ctx.orgId}`;
  });

  afterEach(async () => {
    await db.delete(oauthResource).where(like(oauthResource.identifier, `${orgResource}%`));
  });

  async function connect(cookie: string, clientId: string, resource = orgResource) {
    return authorizationCodeFlow(app, {
      cookie,
      clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      resource,
    });
  }

  describe("personal list", () => {
    it("lists a connected client once, with its target, origin and last use", async () => {
      // The browser session predates this second (token timestamps have
      // one-second resolution): the grant is dated by its authorization, not
      // by the session that granted it.
      await Bun.sleep(1100);
      const authorizedAfter = Math.floor(Date.now() / 1000) * 1000;
      const clientId = await registerClient();
      const { token } = await connect(ctx.cookie, clientId);
      expect((await mcpInitialize(orgPath, String(token.access_token))).status).toBe(200);

      const grants = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      expect(grants).toHaveLength(1);
      const grant = grants[0]!;
      expect(grant.id.startsWith("mcg_")).toBe(true);
      expect(grant.client_name).toBe("Claude Code");
      expect(grant.client_registration).toBe("dynamic");
      // The redirect host is the one thing a dynamic registrant cannot fake.
      expect(grant.client_origin).toBe("claude.example.test");
      expect(grant.target).toEqual({
        orgId: ctx.orgId,
        org_name: "Acme",
        spaceId: null,
        space_name: null,
      });
      expect(grant.session_count).toBe(1);
      expect(grant.lastUsedAt).not.toBeNull();
      expect(Date.parse(grant.createdAt)).toBeGreaterThanOrEqual(authorizedAfter);
    });

    it("groups two authorizations of one client into one grant", async () => {
      const clientId = await registerClient();
      await connect(ctx.cookie, clientId);
      await connect(ctx.cookie, clientId);
      const grants = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      expect(grants).toHaveLength(1);
      expect(grants[0]!.session_count).toBe(2);
    });

    it("keeps an org grant and a space grant of the same client apart", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Ops", visibility: "closed" });
      await seedSpaceMember({ spaceId: space.id, userId: ctx.user.id, presetRole: "admin" });
      const clientId = await registerClient();
      await connect(ctx.cookie, clientId);
      await connect(ctx.cookie, clientId, getMcpSpaceResourceUri(ctx.orgId, space.id));

      const grants = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      expect(grants).toHaveLength(2);
      const spaceGrant = grants.find((g) => g.target?.spaceId === space.id);
      expect(spaceGrant?.target?.space_name).toBe("Ops");
    });

    it("lists a client authorized without offline_access from its issuance", async () => {
      const clientId = await registerClient();
      const { token } = await authorizationCodeFlow(app, {
        cookie: ctx.cookie,
        clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid mcp:read mcp:invoke",
        resource: orgResource,
      });
      expect(token.refresh_token).toBeUndefined();
      // Listed before its first call, so « Revoke all » reaches it.
      const [grant] = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      expect(grant?.session_count).toBe(0);
      expect(grant?.lastUsedAt).toBeNull();

      const all = await app.request("/api/auth/access-grants/revoke-all", {
        method: "POST",
        headers: { Cookie: ctx.cookie },
      });
      expect(((await all.json()) as { revoked_count: number }).revoked_count).toBe(1);
      expect((await mcpInitialize(orgPath, String(token.access_token))).status).toBe(401);
    });

    it("drops a grant whose space was deleted", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Gone", visibility: "closed" });
      await seedSpaceMember({ spaceId: space.id, userId: ctx.user.id, presetRole: "admin" });
      await connect(
        ctx.cookie,
        await registerClient(),
        getMcpSpaceResourceUri(ctx.orgId, space.id),
      );
      await deleteSpace(ctx.orgId, space.id);
      expect((await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp")).toHaveLength(0);
    });

    it("refuses an API key and an MCP bearer: browser session only", async () => {
      const clientId = await registerClient();
      const { token } = await connect(ctx.cookie, clientId);
      const key = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: [],
      });
      for (const bearer of [key.rawKey, String(token.access_token)]) {
        const list = await app.request("/api/auth/access-grants", {
          headers: { Authorization: `Bearer ${bearer}` },
        });
        expect(list.status).toBe(401);
        const all = await app.request("/api/auth/access-grants/revoke-all", {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}` },
        });
        expect(all.status).toBe(401);
      }
      expect((await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp")).toHaveLength(1);
    });
  });

  describe("personal revocation", () => {
    it("cuts the client off on its next request and asks for consent again", async () => {
      const clientId = await registerClient();
      const first = await connect(ctx.cookie, clientId);
      expect(first.consentShown).toBe(true);
      const bearer = String(first.token.access_token);
      expect((await mcpInitialize(orgPath, bearer)).status).toBe(200);
      const [grant] = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");

      const res = await revokeMine(ctx.cookie, grant!.id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { revoked: boolean }).revoked).toBe(true);

      // The access token is still unexpired, and refused.
      expect((await mcpInitialize(orgPath, bearer)).status).toBe(401);
      // The refresh token is gone.
      expect((await refresh(clientId, String(first.token.refresh_token), orgResource)).status).toBe(
        400,
      );
      const live = await db
        .select({ id: oauthRefreshToken.id })
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.clientId, clientId));
      expect(live).toHaveLength(0);
      expect((await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp")).toHaveLength(0);

      // Reconnecting goes through the consent screen, and the new token works.
      // A JWT's `iat` has one-second resolution, so a token minted in the
      // revocation's own second is refused too: start the next one past it.
      await Bun.sleep(1000 - (Date.now() % 1000) + 10);
      const again = await connect(ctx.cookie, clientId);
      expect(again.consentShown).toBe(true);
      expect((await mcpInitialize(orgPath, String(again.token.access_token))).status).toBe(200);
    });

    it("refuses a code given before the revocation, exchanged after it", async () => {
      const clientId = await registerClient();
      await connect(ctx.cookie, clientId);
      const input = {
        cookie: ctx.cookie,
        clientId,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        resource: orgResource,
      };
      const pending = await authorizeCode(app, input);
      const [grant] = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      await revokeMine(ctx.cookie, grant!.id);

      const res = await exchangeCode(app, { ...input, ...pending });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
      expect(body).not.toHaveProperty("access_token");
      const live = await db
        .select({ id: oauthRefreshToken.id })
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.clientId, clientId));
      expect(live).toHaveLength(0);
      expect((await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp")).toHaveLength(0);
    });

    it("keeps the other endpoint of one authorization covering two", async () => {
      const ops = await seedSpace({ orgId: ctx.orgId, name: "Ops", visibility: "closed" });
      const lab = await seedSpace({ orgId: ctx.orgId, name: "Lab", visibility: "closed" });
      for (const space of [ops, lab]) {
        await seedSpaceMember({ spaceId: space.id, userId: ctx.user.id, presetRole: "admin" });
      }
      const opsResource = getMcpSpaceResourceUri(ctx.orgId, ops.id);
      const labResource = getMcpSpaceResourceUri(ctx.orgId, lab.id);
      const clientId = await registerClient();
      // One authorization for both endpoints: one refresh token carrying both.
      const { token } = await authorizationCodeFlow(app, {
        cookie: ctx.cookie,
        clientId,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        resource: [opsResource, labResource],
      });
      const onLab = await refresh(clientId, String(token.refresh_token), labResource);
      expect(onLab.status).toBe(200);
      const labToken = (await onLab.json()) as { access_token: string; refresh_token: string };

      const grants = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      expect(grants.map((g) => g.target?.space_name).sort()).toEqual(["Lab", "Ops"]);
      await revokeMine(ctx.cookie, grants.find((g) => g.target?.spaceId === ops.id)!.id);

      expect((await refresh(clientId, labToken.refresh_token, opsResource)).status).toBe(400);
      const again = await refresh(clientId, labToken.refresh_token, labResource);
      expect(again.status).toBe(200);
      const renewed = (await again.json()) as { access_token: string };
      expect((await mcpInitialize(`${orgPath}/s/${lab.id}`, renewed.access_token)).status).toBe(
        200,
      );
      const remaining = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      expect(remaining.map((g) => g.target?.spaceId)).toEqual([lab.id]);
    });

    it("leaves the same client's grant on another endpoint working, refresh included", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Ops", visibility: "closed" });
      await seedSpaceMember({ spaceId: space.id, userId: ctx.user.id, presetRole: "admin" });
      const spaceResource = getMcpSpaceResourceUri(ctx.orgId, space.id);
      const clientId = await registerClient();
      const onOrg = await connect(ctx.cookie, clientId);
      const onSpace = await connect(ctx.cookie, clientId, spaceResource);
      const orgGrant = (await myGrants(ctx.cookie)).find((g) => g.target?.spaceId === null);
      await revokeMine(ctx.cookie, orgGrant!.id);

      // The revoked grant's client retries its refresh token: refused, and
      // Better Auth must not take it for a stolen token and wipe the client's
      // other refresh tokens.
      expect((await refresh(clientId, String(onOrg.token.refresh_token), orgResource)).status).toBe(
        400,
      );
      const grants = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      expect(grants.map((g) => g.target?.spaceId)).toEqual([space.id]);
      const refreshed = await refresh(clientId, String(onSpace.token.refresh_token), spaceResource);
      expect(refreshed.status).toBe(200);
    });

    it("records the revocation in the org's audit log", async () => {
      const clientId = await registerClient();
      await connect(ctx.cookie, clientId);
      const [grant] = (await myGrants(ctx.cookie)).filter((g) => g.kind === "mcp");
      await revokeMine(ctx.cookie, grant!.id);
      const events = await db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "oauth_grant.revoked")),
        );
      expect(events).toHaveLength(1);
      expect(events[0]!.actorId).toBe(ctx.user.id);
      expect(events[0]!.resourceId).toBe(grant!.id);
    });

    it("answers revoked: false for another user's grant and leaves it alone", async () => {
      const other = await memberContext(ctx, "member");
      const clientId = await registerClient();
      const { token } = await connect(other.cookie, clientId);
      const [theirs] = (await myGrants(other.cookie)).filter((g) => g.kind === "mcp");

      const res = await revokeMine(ctx.cookie, theirs!.id);
      expect(((await res.json()) as { revoked: boolean }).revoked).toBe(false);
      expect((await mcpInitialize(orgPath, String(token.access_token))).status).toBe(200);
    });

    it("revoke-all ends every MCP grant of the caller", async () => {
      const a = await registerClient("Client A");
      const b = await registerClient("Client B");
      const tokenA = String((await connect(ctx.cookie, a)).token.access_token);
      const tokenB = String((await connect(ctx.cookie, b)).token.access_token);

      const res = await app.request("/api/auth/access-grants/revoke-all", {
        method: "POST",
        headers: { Cookie: ctx.cookie },
      });
      expect(((await res.json()) as { revoked_count: number }).revoked_count).toBe(2);
      expect((await mcpInitialize(orgPath, tokenA)).status).toBe(401);
      expect((await mcpInitialize(orgPath, tokenB)).status).toBe(401);
    });
  });

  describe("org admin", () => {
    it("lists a member's grant on the org with its holder, and only this org's", async () => {
      const member = await memberContext(ctx, "member");
      const clientId = await registerClient();
      await connect(member.cookie, clientId);

      const other = await createTestContext({ orgName: "Elsewhere" });
      await mcpModule.events!.onOrgCreate!(other.orgId, other.user.email);
      await authorizationCodeFlow(app, {
        cookie: other.cookie,
        clientId: await registerClient(),
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        resource: getMcpOrgResourceUri(other.orgId),
      });

      const grants = (await orgGrants(ctx.cookie, ctx.orgId)).filter((g) => g.kind === "mcp");
      expect(grants).toHaveLength(1);
      expect(grants[0]!.user?.id).toBe(member.user.id);
      expect(grants[0]!.revocable).toBe(true);

      await db
        .delete(oauthResource)
        .where(like(oauthResource.identifier, `${getMcpOrgResourceUri(other.orgId)}%`));
    });

    it("does not show a member's grant on their personal space", async () => {
      const member = await memberContext(ctx, "member");
      const personal = await ensurePersonalSpaceFor(ctx.orgId, member.user.id);
      await connect(
        member.cookie,
        await registerClient(),
        getMcpSpaceResourceUri(ctx.orgId, personal.id),
      );
      expect((await myGrants(member.cookie)).filter((g) => g.kind === "mcp")).toHaveLength(1);
      expect((await orgGrants(ctx.cookie, ctx.orgId)).filter((g) => g.kind === "mcp")).toHaveLength(
        0,
      );
    });

    it("refuses a member", async () => {
      const member = await memberContext(ctx, "member");
      const res = await app.request(`/api/orgs/${ctx.orgId}/access-grants`, {
        headers: { Cookie: member.cookie },
      });
      expect(res.status).toBe(403);
    });

    it("ends a member's grant, cutting the client off", async () => {
      const member = await memberContext(ctx, "member");
      const clientId = await registerClient();
      const bearer = String((await connect(member.cookie, clientId)).token.access_token);
      expect((await mcpInitialize(orgPath, bearer)).status).toBe(200);
      const [grant] = (await orgGrants(ctx.cookie, ctx.orgId)).filter((g) => g.kind === "mcp");

      const res = await app.request(`/api/orgs/${ctx.orgId}/access-grants/${grant!.id}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(204);
      expect((await mcpInitialize(orgPath, bearer)).status).toBe(401);

      const again = await app.request(`/api/orgs/${ctx.orgId}/access-grants/${grant!.id}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
      expect(again.status).toBe(404);
    });

    it("records a space grant's revocation under its space", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Ops", visibility: "closed" });
      await seedSpaceMember({ spaceId: space.id, userId: ctx.user.id, presetRole: "admin" });
      await connect(
        ctx.cookie,
        await registerClient(),
        getMcpSpaceResourceUri(ctx.orgId, space.id),
      );
      const [grant] = (await orgGrants(ctx.cookie, ctx.orgId)).filter((g) => g.kind === "mcp");
      const res = await app.request(`/api/orgs/${ctx.orgId}/access-grants/${grant!.id}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(204);
      const [event] = await db
        .select({ spaceId: auditEvents.spaceId })
        .from(auditEvents)
        .where(
          and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "oauth_grant.revoked")),
        );
      expect(event?.spaceId).toBe(space.id);
    });

    it("answers 404 for a grant of another org", async () => {
      const other = await createTestContext();
      await mcpModule.events!.onOrgCreate!(other.orgId, other.user.email);
      const otherResource = getMcpOrgResourceUri(other.orgId);
      await authorizationCodeFlow(app, {
        cookie: other.cookie,
        clientId: await registerClient(),
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        resource: otherResource,
      });
      const [theirs] = (await myGrants(other.cookie)).filter((g) => g.kind === "mcp");
      const res = await app.request(`/api/orgs/${ctx.orgId}/access-grants/${theirs!.id}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(404);
      expect((await myGrants(other.cookie)).filter((g) => g.kind === "mcp")).toHaveLength(1);
      await db.delete(oauthResource).where(like(oauthResource.identifier, `${otherResource}%`));
    });
  });
  // Better Auth takes a revoked refresh token presented again for a stolen one
  // and deletes every refresh token of the (client, user) pair, on every
  // resource. The platform therefore deletes the tokens it ends: none of these
  // replays may cost the client its grants elsewhere.
  describe("ending access spares the client's other grants", () => {
    /** Other orgs' MCP resources a test registered, removed after it. */
    let otherResources: string[] = [];
    afterEach(async () => {
      for (const resource of otherResources) {
        await db.delete(oauthResource).where(like(oauthResource.identifier, `${resource}%`));
      }
      otherResources = [];
    });

    async function expectInvalidGrant(res: Response): Promise<void> {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe("invalid_grant");
    }

    async function expectRefreshWorks(
      clientId: string,
      refreshToken: string,
      resource: string,
      mcpPath: string,
    ): Promise<void> {
      const res = await refresh(clientId, refreshToken, resource);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { access_token: string };
      expect((await mcpInitialize(mcpPath, body.access_token)).status).toBe(200);
    }

    /** One client authorized by `cookie`'s user on this org and on a second one, B. */
    async function twoOrgGrants(cookie: string, userEmail: string, userId: string) {
      const { org: other } = await createTestOrg(userId, { name: "Beta" });
      await mcpModule.events!.onOrgCreate!(other.id, userEmail);
      const otherResource = getMcpOrgResourceUri(other.id);
      otherResources.push(otherResource);
      const otherPath = `/api/mcp/o/${other.id}`;
      const clientId = await registerClient();
      const onA = await connect(cookie, clientId);
      const onB = await connect(cookie, clientId, otherResource);
      return { other, otherResource, otherPath, clientId, onA, onB };
    }

    /**
     * A member of this org (A), holding a space of it, and of B, with one
     * client authorized on A, on the space and on B, and A's chain rotated
     * once (Better Auth keeps the rotated-out row, marked revoked).
     */
    async function memberWithGrantsOnTwoOrgs() {
      const member = await memberContext(ctx, "member");
      const space = await seedSpace({ orgId: ctx.orgId, name: "Ops", visibility: "closed" });
      await seedSpaceMember({ spaceId: space.id, userId: member.user.id, presetRole: "admin" });
      const spaceResource = getMcpSpaceResourceUri(ctx.orgId, space.id);
      const spacePath = `${orgPath}/s/${space.id}`;
      const grants = await twoOrgGrants(member.cookie, member.user.email, member.user.id);
      const onSpace = await connect(member.cookie, grants.clientId, spaceResource);
      expect((await mcpInitialize(spacePath, String(onSpace.token.access_token))).status).toBe(200);
      const rotated = await refresh(
        grants.clientId,
        String(grants.onA.token.refresh_token),
        orgResource,
      );
      expect(rotated.status).toBe(200);
      const currentA = ((await rotated.json()) as { refresh_token: string }).refresh_token;
      return { member, spaceResource, spacePath, onSpace, currentA, ...grants };
    }

    type ExitedMember = Awaited<ReturnType<typeof memberWithGrantsOnTwoOrgs>>;

    /** Nothing of A works any more, its space included, and B still does. */
    async function expectOnlyBSurvives(m: ExitedMember): Promise<void> {
      await expectInvalidGrant(await refresh(m.clientId, m.currentA, orgResource));
      await expectInvalidGrant(
        await refresh(m.clientId, String(m.onA.token.refresh_token), orgResource),
      );
      await expectInvalidGrant(
        await refresh(m.clientId, String(m.onSpace.token.refresh_token), m.spaceResource),
      );
      expect((await mcpInitialize(orgPath, String(m.onA.token.access_token))).status).toBe(401);
      expect((await mcpInitialize(m.spacePath, String(m.onSpace.token.access_token))).status).toBe(
        401,
      );
      await expectRefreshWorks(
        m.clientId,
        String(m.onB.token.refresh_token),
        m.otherResource,
        m.otherPath,
      );
    }

    function removeMember(userId: string) {
      return app.request(`/api/orgs/${ctx.orgId}/members/${userId}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
    }

    it("a member removed from one org keeps the same client's grant on another", async () => {
      const m = await memberWithGrantsOnTwoOrgs();
      expect((await removeMember(m.member.user.id)).status).toBe(204);
      await expectOnlyBSurvives(m);
    });

    it("a member leaving one org keeps the same client's grant on another", async () => {
      const m = await memberWithGrantsOnTwoOrgs();
      const left = await app.request(`/api/orgs/${ctx.orgId}/leave`, {
        method: "POST",
        headers: { Cookie: m.member.cookie },
      });
      expect(left.status).toBe(204);
      await expectOnlyBSurvives(m);
    });

    it("a member re-invited after removal gets none of the old tokens back", async () => {
      const m = await memberWithGrantsOnTwoOrgs();
      expect((await removeMember(m.member.user.id)).status).toBe(204);
      const invitation = await seedInvitation({
        orgId: ctx.orgId,
        email: m.member.user.email,
        invitedBy: ctx.user.id,
      });
      const accepted = await app.request(`/invite/${invitation.token}/accept`, {
        method: "POST",
        headers: { Cookie: m.member.cookie },
      });
      expect(accepted.status).toBe(200);

      // Membership is back: the old tokens stay refused by themselves.
      await expectInvalidGrant(await refresh(m.clientId, m.currentA, orgResource));
      await expectInvalidGrant(
        await refresh(m.clientId, String(m.onA.token.refresh_token), orgResource),
      );
      expect((await mcpInitialize(orgPath, String(m.onA.token.access_token))).status).toBe(401);

      // A JWT's `iat` has one-second resolution: start past the exit's second.
      await Bun.sleep(1000 - (Date.now() % 1000) + 10);
      const again = await connect(m.member.cookie, m.clientId);
      expect(again.consentShown).toBe(true);
      expect((await mcpInitialize(orgPath, String(again.token.access_token))).status).toBe(200);
      await expectRefreshWorks(
        m.clientId,
        String(m.onB.token.refresh_token),
        m.otherResource,
        m.otherPath,
      );
    });

    // RFC 7009 revocation by the client itself: Better Auth marks the row
    // revoked, and the same token presented again would tear down the family.
    it("a refresh token the client revoked, presented again, costs it no other grant", async () => {
      const { otherResource, otherPath, clientId, onA, onB } = await twoOrgGrants(
        ctx.cookie,
        ctx.user.email,
        ctx.user.id,
      );
      const tokenA = String(onA.token.refresh_token);
      const revoke = () => revokeRefreshToken(clientId, tokenA);
      expect((await revoke()).status).toBe(200);
      // Gone, not marked: the repeat is a plain refusal (the provider answers
      // 400 where RFC 7009 §2.2 says 200), never a family teardown.
      const repeat = await revoke();
      expect(repeat.status).toBe(400);
      expect(((await repeat.json()) as { error?: string }).error).toBe("invalid_request");
      await expectInvalidGrant(await refresh(clientId, tokenA, orgResource));
      await expectRefreshWorks(clientId, String(onB.token.refresh_token), otherResource, otherPath);
    });

    // Better Auth strips an authorization scheme from the token it revokes; the
    // deletion applies the same normalisation.
    it("a refresh token revoked as `Bearer <token>` is deleted too", async () => {
      const { otherResource, otherPath, clientId, onA, onB } = await twoOrgGrants(
        ctx.cookie,
        ctx.user.email,
        ctx.user.id,
      );
      const tokenA = String(onA.token.refresh_token);
      const revoke = () => revokeRefreshToken(clientId, `Bearer ${tokenA}`);
      expect((await revoke()).status).toBe(200);
      expect((await revoke()).status).toBe(400);
      await expectRefreshWorks(clientId, String(onB.token.refresh_token), otherResource, otherPath);
    });

    // MCP clients present one refresh token twice (anthropics/claude-ai-mcp#1194).
    // Within `refreshTokenReuseInterval`, the second presentation is a replay of
    // the first rotation's response, never a theft: no grant elsewhere is lost.
    describe("a refresh token presented twice within the reuse window", () => {
      async function refreshRowCount(clientId: string): Promise<number> {
        const rows = await db
          .select({ id: oauthRefreshToken.id })
          .from(oauthRefreshToken)
          .where(eq(oauthRefreshToken.clientId, clientId));
        return rows.length;
      }

      it("answers the second with the first's tokens and keeps the client's other grants", async () => {
        const { other, otherResource, clientId, onA, onB } = await twoOrgGrants(
          ctx.cookie,
          ctx.user.email,
          ctx.user.id,
        );
        const original = String(onA.token.refresh_token);
        const first = await refresh(clientId, original, orgResource);
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as { access_token: string; refresh_token: string };
        const rowsAfterRotation = await refreshRowCount(clientId);

        const second = await refresh(clientId, original, orgResource);
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as {
          access_token: string;
          refresh_token: string;
        };
        // A replay of the stored response: nothing new is minted or stored.
        expect(secondBody.access_token).toBe(firstBody.access_token);
        expect(secondBody.refresh_token).toBe(firstBody.refresh_token);
        expect(await refreshRowCount(clientId)).toBe(rowsAfterRotation);
        expect((await mcpInitialize(orgPath, secondBody.access_token)).status).toBe(200);

        // The chain goes on from the rotated token, and B never noticed.
        await expectRefreshWorks(clientId, secondBody.refresh_token, orgResource, orgPath);
        await expectRefreshWorks(
          clientId,
          String(onB.token.refresh_token),
          otherResource,
          `/api/mcp/o/${other.id}`,
        );
      });

      it("survives two refreshes of one token fired together, and keeps the client's other grants", async () => {
        const { otherResource, otherPath, clientId, onA, onB } = await twoOrgGrants(
          ctx.cookie,
          ctx.user.email,
          ctx.user.id,
        );
        const original = String(onA.token.refresh_token);
        const both = await Promise.all([
          refresh(clientId, original, orgResource),
          refresh(clientId, original, orgResource),
        ]);
        const statuses = both.map((res) => res.status);
        // Which one wins is the provider's: neither may fail, nor end the family.
        expect(statuses).toContain(200);
        for (const status of statuses) expect(status).toBeLessThan(500);
        await expectRefreshWorks(
          clientId,
          String(onB.token.refresh_token),
          otherResource,
          otherPath,
        );
      });

      it("refuses a second presentation asking for other scopes, and keeps every grant", async () => {
        const { other, otherResource, clientId, onA, onB } = await twoOrgGrants(
          ctx.cookie,
          ctx.user.email,
          ctx.user.id,
        );
        const original = String(onA.token.refresh_token);
        const first = await refresh(clientId, original, orgResource);
        expect(first.status).toBe(200);
        const current = ((await first.json()) as { refresh_token: string }).refresh_token;

        // Not the request the stored response answered: a plain refusal.
        const narrower = await app.request("/api/auth/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: original,
            client_id: clientId,
            resource: orgResource,
            scope: "openid mcp:read",
          }).toString(),
        });
        await expectInvalidGrant(narrower);

        await expectRefreshWorks(clientId, current, orgResource, orgPath);
        await expectRefreshWorks(
          clientId,
          String(onB.token.refresh_token),
          otherResource,
          `/api/mcp/o/${other.id}`,
        );
      });

      it("refuses it once the grant was revoked, and keeps the client's other grants", async () => {
        const { other, otherResource, clientId, onA, onB } = await twoOrgGrants(
          ctx.cookie,
          ctx.user.email,
          ctx.user.id,
        );
        const original = String(onA.token.refresh_token);
        const first = await refresh(clientId, original, orgResource);
        expect(first.status).toBe(200);
        const rotatedAccess = ((await first.json()) as { access_token: string }).access_token;
        const grantA = (await myGrants(ctx.cookie)).find(
          (g) => g.kind === "mcp" && g.target?.orgId === ctx.orgId,
        );
        expect((await revokeMine(ctx.cookie, grantA!.id)).status).toBe(200);

        // The rotated-out row is gone with the grant: no stored response to replay.
        const replay = await refresh(clientId, original, orgResource);
        expect(replay.status).toBe(400);
        const body = (await replay.json()) as Record<string, unknown>;
        expect(body.error).toBe("invalid_grant");
        expect(body).not.toHaveProperty("access_token");
        // What the first rotation minted is refused too.
        expect((await mcpInitialize(orgPath, rotatedAccess)).status).toBe(401);
        // Nothing of A came back.
        const remaining = await db
          .select({ resources: oauthRefreshToken.resources })
          .from(oauthRefreshToken)
          .where(eq(oauthRefreshToken.clientId, clientId));
        expect(remaining.flatMap((r) => r.resources ?? [])).not.toContain(orgResource);

        await expectRefreshWorks(
          clientId,
          String(onB.token.refresh_token),
          otherResource,
          `/api/mcp/o/${other.id}`,
        );
      });

      it("refuses it on the revoked endpoint of an authorization covering two", async () => {
        const ops = await seedSpace({ orgId: ctx.orgId, name: "Ops", visibility: "closed" });
        const lab = await seedSpace({ orgId: ctx.orgId, name: "Lab", visibility: "closed" });
        for (const space of [ops, lab]) {
          await seedSpaceMember({ spaceId: space.id, userId: ctx.user.id, presetRole: "admin" });
        }
        const opsResource = getMcpSpaceResourceUri(ctx.orgId, ops.id);
        const labResource = getMcpSpaceResourceUri(ctx.orgId, lab.id);
        const clientId = await registerClient();
        const { token } = await authorizationCodeFlow(app, {
          cookie: ctx.cookie,
          clientId,
          redirectUri: REDIRECT_URI,
          scope: SCOPE,
          resource: [opsResource, labResource],
        });
        const original = String(token.refresh_token);
        const rotated = await refresh(clientId, original, opsResource);
        expect(rotated.status).toBe(200);
        const successor = ((await rotated.json()) as { refresh_token: string }).refresh_token;
        const opsGrant = (await myGrants(ctx.cookie)).find((g) => g.target?.spaceId === ops.id);
        await revokeMine(ctx.cookie, opsGrant!.id);

        // The rotated-out row survives for Lab, so its stored Ops response must
        // not be served: the row no longer covers Ops.
        const onOps = await refresh(clientId, original, opsResource);
        expect(onOps.status).toBe(400);
        expect(await onOps.json()).not.toHaveProperty("access_token");
        // And it is a refusal, not a theft: the Lab chain still refreshes.
        await expectRefreshWorks(clientId, successor, labResource, `${orgPath}/s/${lab.id}`);
      });
    });

    it("a password change refuses the old tokens and keeps the grant made after it", async () => {
      const clientId = await registerClient();
      const before = await connect(ctx.cookie, clientId);
      expect((await mcpInitialize(orgPath, String(before.token.access_token))).status).toBe(200);
      const rotated = await refresh(clientId, String(before.token.refresh_token), orgResource);
      expect(rotated.status).toBe(200);
      const old = ((await rotated.json()) as { refresh_token: string }).refresh_token;

      const changed = await app.request("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ctx.cookie },
        body: JSON.stringify({
          currentPassword: "TestPassword123!",
          newPassword: "BrandNewPassword456!",
        }),
      });
      expect(changed.status).toBe(200);

      // The access token issued before the change is refused from its next request.
      expect((await mcpInitialize(orgPath, String(before.token.access_token))).status).toBe(401);

      // Another device of the same client signs in again after the change
      // (past the change's second: a JWT's `iat` has one-second resolution).
      await Bun.sleep(1000 - (Date.now() % 1000) + 10);
      const after = await connect(ctx.cookie, clientId);
      expect((await mcpInitialize(orgPath, String(after.token.access_token))).status).toBe(200);
      await expectInvalidGrant(await refresh(clientId, old, orgResource));
      await expectInvalidGrant(
        await refresh(clientId, String(before.token.refresh_token), orgResource),
      );
      const fresh = await refresh(clientId, String(after.token.refresh_token), orgResource);
      expect(fresh.status).toBe(200);
    });
  });
});
