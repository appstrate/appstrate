// SPDX-License-Identifier: Apache-2.0

/**
 * Owner changes and leaving an organization are dashboard-session only.
 *
 * A self-registered MCP client (DCR/CIMD) is an instance-level client, and its
 * token resolves as the user itself (`authMethod: "oauth2-instance"`,
 * `principalKind: "user"`, full authority) — so `isUserPrincipal` alone would let
 * a prompt-injected agent promote an attacker to owner, remove the real owner,
 * or make the user leave. Real instance JWTs, verified by the real strategy.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { and, eq } from "drizzle-orm";
import { _resetCacheForTesting } from "@appstrate/env";
import { organizationMembers } from "@appstrate/db/schema";
import { db, truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  addOrgMember,
  createTestUser,
  createTestOrg,
} from "../../../../../../test/helpers/auth.ts";

const originalAppUrl = process.env.APP_URL;
let jwksServer: ReturnType<typeof Bun.serve> | null = null;
let privateKey: jose.CryptoKey;
let publicJwk: jose.JWK;
const kid = "owner-changes-test-key-1";
let app: Awaited<ReturnType<typeof import("../../../../../../test/helpers/app.ts").getTestApp>>;

async function startJwksServer() {
  const { publicKey, privateKey: priv } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });
  privateKey = priv;
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "ES256";
  jwk.use = "sig";
  publicJwk = jwk;
  jwksServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/api/auth/jwks") return Response.json({ keys: [jwk] });
      return new Response("not found", { status: 404 });
    },
  });
  process.env.APP_URL = `http://127.0.0.1:${jwksServer.port}`;
  _resetCacheForTesting();
}

async function mintInstanceToken(sub: string, clientId: string): Promise<string> {
  return new jose.SignJWT({
    azp: clientId,
    actor_type: "user",
    email: "owner@example.com",
    name: "Owner",
    scope: "openid profile email",
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(`${process.env.APP_URL!}/api/auth`)
    .setAudience(process.env.APP_URL!)
    .setIssuedAt()
    .setExpirationTime("2m")
    .setSubject(sub)
    .sign(privateKey);
}

beforeAll(async () => {
  await startJwksServer();
  const { getTestApp } = await import("../../../../../../test/helpers/app.ts");
  const { default: oidcModule } = await import("../../../index.ts");
  const { overrideJwks } = await import("../../../services/enduser-token.ts");
  overrideJwks(async () => ({ keys: [publicJwk] }));
  app = getTestApp({ modules: [oidcModule] });
});

afterAll(() => {
  jwksServer?.stop(true);
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  _resetCacheForTesting();
});

describe("owner changes and leaving — dashboard session only", () => {
  let orgId: string;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let coOwnerId: string;
  let memberId: string;
  let bearer: Record<string, string>;

  const roleOf = async (userId: string) =>
    (
      await db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    )[0]?.role;
  const setRole = (headers: Record<string, string>, userId: string, role: string) =>
    app.request(`/api/orgs/${orgId}/members/${userId}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });

  const leaveAs = (headers: Record<string, string>) =>
    app.request(`/api/orgs/${orgId}/leave`, { method: "POST", headers });

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestUser();
    orgId = (await createTestOrg(owner.id)).org.id;
    // A co-owner, so neither leave nor an owner removal is a last-owner 409.
    coOwnerId = (await createTestUser()).id;
    await addOrgMember(orgId, coOwnerId, "owner");
    memberId = (await createTestUser()).id;
    await addOrgMember(orgId, memberId, "member");

    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");
    bearer = { Authorization: `Bearer ${await mintInstanceToken(owner.id, clientId)}` };
  });

  it("refuses an instance token on leave, owner promotion, demotion and removal", async () => {
    const leave = await leaveAs(bearer);
    expect(leave.status, await leave.clone().text()).toBe(403);
    expect(await roleOf(owner.id)).toBe("owner");

    expect((await setRole(bearer, memberId, "owner")).status).toBe(403);
    expect((await setRole(bearer, coOwnerId, "member")).status).toBe(403);
    const remove = await app.request(`/api/orgs/${orgId}/members/${coOwnerId}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(remove.status).toBe(403);
    expect(await roleOf(memberId)).toBe("member");
    expect(await roleOf(coOwnerId)).toBe("owner");
  });

  it("still lets the same token manage non-owners — the owner rule, not RBAC", async () => {
    const res = await setRole(bearer, memberId, "admin");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await roleOf(memberId)).toBe("admin");
  });

  it("lets the dashboard session do all of it", async () => {
    const session = { Cookie: owner.cookie };
    expect((await setRole(session, memberId, "owner")).status).toBe(200);
    expect(await roleOf(memberId)).toBe("owner");

    const leave = await leaveAs(session);
    expect(leave.status, await leave.clone().text()).toBe(204);
    expect(await roleOf(owner.id)).toBeUndefined();
  });
});
