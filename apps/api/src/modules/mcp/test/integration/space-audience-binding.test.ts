// SPDX-License-Identifier: Apache-2.0

/**
 * How the OIDC strategy and the audience guard read a token's MCP audience,
 * with self-minted tokens for the shapes the authorization server never issues:
 *
 *   - a token whose `aud` names both the organization's resource and one of its
 *     spaces is refused on both endpoints, whichever order the two appear in;
 *   - a principal already pinned to a space (an end-user) whose audience names
 *     another space contradicts itself and does not authenticate.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { endUsers, oidcEndUserProfiles } from "@appstrate/db/schema";
import { prefixedId } from "@appstrate/db/ids";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { db, truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import { seedSpace, seedSpaceMember } from "../../../../../test/helpers/seed.ts";
import { MCP_ACCEPT } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri, getMcpSpaceResourceUri } from "../../../../lib/audiences.ts";
import { overrideJwks } from "../../../oidc/services/enduser-token.ts";
import { oidcAuthStrategy } from "../../../oidc/auth/strategy.ts";
import mcpModule from "../../index.ts";

const app = getTestApp();
await registerTestPlatformApp();

const KID = "mcp-space-audience-key";
let signingKey: jose.CryptoKey;

async function sign(claims: Record<string, unknown>, audience: string[]): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(`${process.env.APP_URL!}/api/auth`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(signingKey);
}

async function mcpInitialize(path: string, token: string): Promise<Response> {
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
        clientInfo: { name: "space-audience-binding-test", version: "0" },
      },
    }),
  });
}

function authenticate(token: string) {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  return oidcAuthStrategy.authenticate({
    headers,
    method: "POST",
    path: "/api/mcp",
    request: new Request("http://localhost/api/mcp", { method: "POST", headers }),
  });
}

describe("MCP audience binding of self-minted tokens", () => {
  let ctx: TestContext;
  let s1: string;

  beforeAll(async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    signingKey = privateKey;
    const jwk = await jose.exportJWK(publicKey);
    overrideJwks(async () => ({ keys: [{ ...jwk, kid: KID, alg: "ES256", use: "sig" }] }));
  });

  afterAll(() => overrideJwks(null));

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext();
    s1 = (await seedSpace({ orgId: ctx.orgId, name: "S1", visibility: "closed" })).id;
    await seedSpaceMember({ spaceId: s1, userId: ctx.user.id, presetRole: "admin" });
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
  });

  describe("a token bound to the organization AND one of its spaces", () => {
    const instanceClaims = () => ({ sub: ctx.user.id, actor_type: "user", scope: "openid" });

    for (const order of ["org first", "space first"] as const) {
      it(`is refused on both endpoints (${order})`, async () => {
        const orgUri = getMcpOrgResourceUri(ctx.orgId);
        const spaceUri = getMcpSpaceResourceUri(ctx.orgId, s1);
        const token = await sign(
          instanceClaims(),
          order === "org first" ? [orgUri, spaceUri] : [spaceUri, orgUri],
        );

        expect((await mcpInitialize(`/api/mcp/o/${ctx.orgId}`, token)).status).toBe(401);
        expect((await mcpInitialize(`/api/mcp/o/${ctx.orgId}/s/${s1}`, token)).status).toBe(401);
      });
    }

    it("the control: the same token bound to the space alone is served there", async () => {
      const token = await sign(instanceClaims(), [getMcpSpaceResourceUri(ctx.orgId, s1)]);
      expect((await mcpInitialize(`/api/mcp/o/${ctx.orgId}/s/${s1}`, token)).status).toBe(200);
    });
  });

  describe("a principal pinned to a space whose audience names another space", () => {
    async function endUserToken(audienceSpaceId: string): Promise<string> {
      const authUser = await createTestUser();
      const endUserId = prefixedId("eu");
      await db
        .insert(endUsers)
        .values({ id: endUserId, spaceId: ctx.defaultSpaceId, orgId: ctx.orgId, name: "Embedded" });
      await db
        .insert(oidcEndUserProfiles)
        .values({ endUserId, authUserId: authUser.id, emailVerified: true, status: "active" });
      return sign(
        {
          sub: authUser.id,
          actor_type: "end_user",
          end_user_id: endUserId,
          space_id: ctx.defaultSpaceId,
          scope: "openid mcp:read",
        },
        [getMcpSpaceResourceUri(ctx.orgId, audienceSpaceId)],
      );
    }

    it("does not authenticate", async () => {
      const token = await endUserToken(s1);
      expect(await authenticate(token)).toBeNull();
      expect((await mcpInitialize(`/api/mcp/o/${ctx.orgId}/s/${s1}`, token)).status).toBe(401);
    });

    it("the control: an audience naming its own space authenticates, pinned to it", async () => {
      const resolution = await authenticate(await endUserToken(ctx.defaultSpaceId));
      expect(resolution).not.toBeNull();
      expect(resolution!.spaceId).toBe(ctx.defaultSpaceId);
    });
  });
});
