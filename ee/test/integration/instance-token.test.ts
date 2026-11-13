// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * An MCP or CLI instance token resolves as the user themselves (principal
 * `user`, RBAC spec §7), so an owner's token holds `org-sso:write` through the
 * role. The service still refuses it: enterprise sign-in changes are made from
 * a dashboard session only. Real instance JWTs, verified by the real strategy.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { _resetCacheForTesting } from "@appstrate/env";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestOrg, createTestUser } from "../../../apps/api/test/helpers/auth.ts";
import { getConnection } from "../../src/sso/store.ts";
import { DOMAIN, seedSso } from "../helpers/sso.ts";

const originalAppUrl = process.env.APP_URL;
const kid = "org-sso-instance-token-key";
let jwksServer: ReturnType<typeof Bun.serve> | null = null;
let privateKey: jose.CryptoKey;
let app: { request(path: string, init?: RequestInit): Response | Promise<Response> };

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
  const { publicKey, privateKey: priv } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });
  privateKey = priv;
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  jwksServer = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/api/auth/jwks"
        ? Response.json({ keys: [jwk] })
        : new Response("not found", { status: 404 }),
  });
  process.env.APP_URL = `http://127.0.0.1:${jwksServer.port}`;
  _resetCacheForTesting();
  const { getTestApp } = await import("../../../apps/api/test/helpers/app.ts");
  const { default: oidcModule } = await import("../../../apps/api/src/modules/oidc/index.ts");
  const { overrideJwks } =
    await import("../../../apps/api/src/modules/oidc/services/enduser-token.ts");
  const { default: eeModule } = await import("../../src/index.ts");
  overrideJwks(async () => ({ keys: [jwk] }));
  app = getTestApp({ modules: [oidcModule, eeModule] });
});

afterAll(() => {
  jwksServer?.stop(true);
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  _resetCacheForTesting();
});

describe("enterprise sign-in through an instance token", () => {
  let orgId: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    const owner = await createTestUser();
    orgId = (await createTestOrg(owner.id)).org.id;
    const { ensureInstanceClient } =
      await import("../../../apps/api/src/modules/oidc/services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");
    headers = {
      Authorization: `Bearer ${await mintInstanceToken(owner.id, clientId)}`,
      "X-Org-Id": orgId,
    };
  });

  it("reads, as the owner it acts for", async () => {
    const res = await app.request("/api/org-sso", { headers });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("changes nothing, even for an owner", async () => {
    await seedSso({ orgId, enforced: true });
    for (const [method, path, body] of [
      ["POST", "/api/org-sso/domains", { domain: `other.${DOMAIN}` }],
      ["DELETE", "/api/org-sso/enforcement", undefined],
      ["PATCH", "/api/org-sso", { join_role: "guest" }],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("dashboard_session_required");
    }
    const connection = await getConnection(orgId);
    expect(connection?.enforcedAt).not.toBeNull();
    expect(connection?.joinRole).toBe("member");
  });
});
