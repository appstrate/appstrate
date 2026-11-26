// SPDX-License-Identifier: Apache-2.0

/**
 * A member's personal-space override, read through a minted MCP instance token: the token
 * resolves as the user itself (`principalKind: "user"`), so it must see the same capped role
 * a session sees (RBAC spec §3.6, §7). Real instance JWTs, verified by the real strategy.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { _resetCacheForTesting } from "@appstrate/env";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { seedSpaceRole } from "../../../../../../test/helpers/seed.ts";
import { DELETES } from "../../../../../../test/helpers/personal-space.ts";

const originalAppUrl = process.env.APP_URL;
let jwksServer: ReturnType<typeof Bun.serve> | null = null;
let privateKey: jose.CryptoKey;
let publicJwk: jose.JWK;
const kid = "personal-space-role-test-key-1";
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

async function mintInstanceToken(ctx: TestContext, clientId: string): Promise<string> {
  return new jose.SignJWT({
    azp: clientId,
    actor_type: "user",
    email: ctx.user.email,
    name: ctx.user.name,
    scope: "openid profile email",
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(`${process.env.APP_URL!}/api/auth`)
    .setAudience(process.env.APP_URL!)
    .setIssuedAt()
    .setExpirationTime("2m")
    .setSubject(ctx.user.id)
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

describe("personal-space override through an MCP instance token", () => {
  let owner: TestContext;
  let member: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "override-instance" });
    member = await memberContext(owner, "member");
  });

  it("reports the override and the floor, and withholds what the bundle does not grant", async () => {
    // A bundle, not `viewer`: every preset grants `studio:read`, a custom role can hide it.
    const role = await seedSpaceRole({
      orgId: owner.orgId,
      key: "reader",
      name: "Reader",
      permissions: ["agents:read"],
      showsStudio: false,
    });
    const put = await app.request(
      `/api/orgs/${owner.orgId}/members/${member.user.id}/personal-space-role`,
      {
        method: "PUT",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ custom_role_id: role.id }),
      },
    );
    expect(put.status, await put.clone().text()).toBe(200);

    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");
    const res = await app.request("/api/spaces", {
      headers: {
        Authorization: `Bearer ${await mintInstanceToken(member, clientId)}`,
        "X-Org-Id": owner.orgId,
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const own = (
      (await res.json()) as {
        data: { personal: boolean; role: { kind: string; key: string }; permissions: string[] }[];
      }
    ).data.filter((s) => s.personal);
    expect(own).toHaveLength(1);
    expect(own[0]!.role).toMatchObject({ kind: "custom", key: "reader" });
    for (const permission of ["agents:read", ...DELETES]) {
      expect(own[0]!.permissions).toContain(permission);
    }
    for (const permission of ["studio:read", "agents:write", "agents:run"]) {
      expect(own[0]!.permissions).not.toContain(permission);
    }
  });

  it("writes and clears the override when the OWNER's instance token carries the request", async () => {
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");
    const bearer = `Bearer ${await mintInstanceToken(owner, clientId)}`;
    const url = `/api/orgs/${owner.orgId}/members/${member.user.id}/personal-space-role`;

    const put = await app.request(url, {
      method: "PUT",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ preset_role: "viewer" }),
    });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await put.json()).toMatchObject({
      userId: member.user.id,
      personal_space_role: { preset_role: "viewer" },
    });

    const memberSees = await app.request("/api/spaces", {
      headers: {
        Authorization: `Bearer ${await mintInstanceToken(member, clientId)}`,
        "X-Org-Id": owner.orgId,
      },
    });
    const own = (
      (await memberSees.json()) as { data: { personal: boolean; role: { key: string } }[] }
    ).data.filter((s) => s.personal);
    expect(own[0]!.role).toMatchObject({ key: "viewer" });

    const del = await app.request(url, { method: "DELETE", headers: { Authorization: bearer } });
    expect(del.status, await del.clone().text()).toBe(204);
  });
});
