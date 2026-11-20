// SPDX-License-Identifier: Apache-2.0

/**
 * An MCP access token is a JWT the strategy verifies without reading the
 * database, so revoking a grant's refresh tokens alone would leave it valid
 * until it expires. The grant's revocation watermark closes that window: a JWT
 * issued at or before it is refused on the next request, and a token minted
 * after it (a new authorization) is accepted. The same check records the
 * grant's last use.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { oauthGrantState, oauthResource } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { db, truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { createTestContext, type TestContext } from "../../../../../../test/helpers/auth.ts";
import { MCP_ACCEPT } from "../../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri } from "../../../../../lib/audiences.ts";
import { overrideJwks } from "../../../services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { authorizationCodeFlow } from "../../helpers/authorization-code-flow.ts";
import mcpModule from "../../../../mcp/index.ts";

const app = getTestApp();
await registerTestPlatformApp();
const REDIRECT_URI = "http://localhost:9921/callback";

async function registerClient(): Promise<string> {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP client (watermark)",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect([200, 201]).toContain(res.status);
  return String(((await res.json()) as { client_id: string }).client_id);
}

function mcpInitialize(orgId: string, token: string, userAgent = "watermark-test/1.0") {
  return app.request(`/api/mcp/o/${orgId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: MCP_ACCEPT,
      Authorization: `Bearer ${token}`,
      "user-agent": userAgent,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "watermark-test", version: "0" },
      },
    }),
  });
}

describe("MCP access grant watermark", () => {
  let ctx: TestContext;
  let resource: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    ctx = await createTestContext();
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    resource = getMcpOrgResourceUri(ctx.orgId);
  });

  afterEach(async () => {
    await db.delete(oauthResource).where(like(oauthResource.identifier, `${resource}%`));
  });

  async function mint(clientId: string): Promise<string> {
    const { token } = await authorizationCodeFlow(app, {
      cookie: ctx.cookie,
      clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid mcp:read mcp:invoke",
      resource,
    });
    return String(token.access_token);
  }

  async function stateOf(clientId: string) {
    const [row] = await db
      .select()
      .from(oauthGrantState)
      .where(and(eq(oauthGrantState.clientId, clientId), eq(oauthGrantState.userId, ctx.user.id)));
    return row;
  }

  it("records the grant's first use with its org, IP and user agent", async () => {
    const clientId = await registerClient();
    const bearer = await mint(clientId);
    expect((await mcpInitialize(ctx.orgId, bearer)).status).toBe(200);

    const row = await stateOf(clientId);
    expect(row).toBeDefined();
    expect(row!.resource).toBe(resource);
    expect(row!.orgId).toBe(ctx.orgId);
    expect(row!.spaceId).toBeNull();
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
    expect(row!.lastUsedUserAgent).toBe("watermark-test/1.0");
    expect(row!.tokensValidAfter).toBeNull();
  });

  it("refuses a token issued before the watermark on the next request", async () => {
    const clientId = await registerClient();
    const bearer = await mint(clientId);
    expect((await mcpInitialize(ctx.orgId, bearer)).status).toBe(200);

    await db
      .update(oauthGrantState)
      .set({ tokensValidAfter: new Date(Date.now() + 1000) })
      .where(eq(oauthGrantState.clientId, clientId));

    expect((await mcpInitialize(ctx.orgId, bearer)).status).toBe(401);
  });

  it("accepts a token minted after the watermark", async () => {
    const clientId = await registerClient();
    await mint(clientId);
    await db.insert(oauthGrantState).values({
      userId: ctx.user.id,
      clientId,
      resource,
      orgId: ctx.orgId,
      tokensValidAfter: new Date(Date.now() - 5000),
    });
    const fresh = await mint(clientId);
    expect((await mcpInitialize(ctx.orgId, fresh)).status).toBe(200);
  });

  it("leaves another client of the same user untouched", async () => {
    const revoked = await registerClient();
    const kept = await registerClient();
    const revokedBearer = await mint(revoked);
    const keptBearer = await mint(kept);
    await db.insert(oauthGrantState).values({
      userId: ctx.user.id,
      clientId: revoked,
      resource,
      orgId: ctx.orgId,
      tokensValidAfter: new Date(Date.now() + 1000),
    });
    expect((await mcpInitialize(ctx.orgId, revokedBearer)).status).toBe(401);
    expect((await mcpInitialize(ctx.orgId, keptBearer)).status).toBe(200);
  });
});
