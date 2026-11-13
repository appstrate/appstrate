// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/** The OIDC module's hosted login page shows an enforced domain's refusal for what it is. */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { flushRedis } from "../../../apps/api/test/helpers/redis.ts";
import {
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { DOMAIN, seedSso } from "../helpers/sso.ts";

const app = getTestApp();

async function registerClient(ctx: TestContext): Promise<string> {
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({
      level: "space",
      name: "Portal",
      redirectUris: ["https://portal.example.com/oauth/callback"],
      referencedSpaceId: ctx.defaultSpaceId,
      allowSignup: true,
    }),
  });
  return ((await res.json()) as { clientId: string }).clientId;
}

describe("hosted login page", () => {
  let ctx: TestContext;
  let clientId: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext();
    await seedSso({ orgId: ctx.orgId, enforced: true });
    clientId = await registerClient(ctx);
  });

  it("explains a password refusal and points to Microsoft", async () => {
    const member = await createTestUser({ email: `alice@${DOMAIN}`, emailVerified: true });
    const page = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`);
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
    const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;
    const res = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
      body: `_csrf=${encodeURIComponent(csrf)}&email=${encodeURIComponent(member.email)}&password=TestPassword123!`,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Continuer avec Microsoft");
  });

  it("explains a refusal carried back by a redirect", async () => {
    const res = await app.request(
      `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&error=sso_tenant_mismatch`,
    );
    expect(await res.text()).toContain("compte professionnel");
  });
});
