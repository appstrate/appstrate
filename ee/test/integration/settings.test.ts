// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * `/api/org-sso`: who may read and change an organization's enterprise
 * sign-in, the DNS proof, one owner per verified domain, the anti-lockout rule
 * and the sessions that end when enforcement starts.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditEvents, deviceCode, session } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { db, truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  authClientFor,
  createTestContext,
  createTestUser,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { seedApiKey } from "../../../apps/api/test/helpers/seed.ts";
import { swapTxtResolverForTesting, type TxtResolver } from "../../src/sso/dns.ts";
import { DOMAIN, OTHER_TENANT, TENANT, seedMicrosoftSession, seedSso } from "../helpers/sso.ts";

const app = getTestApp();
const client = authClientFor(app);

interface Settings {
  tenant_id: string | null;
  join_role: string;
  enforced: boolean;
  caller_tenant_id: string | null;
  domains: {
    id: string;
    domain: string;
    verified: boolean;
    txt_record_name: string;
    txt_record_value: string;
  }[];
}

let txtRecords: Record<string, string[][]> = {};
let previousResolver: TxtResolver;
beforeAll(() => {
  previousResolver = swapTxtResolverForTesting(async (name) => {
    const records = txtRecords[name];
    if (!records) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return records;
  });
});
afterAll(() => {
  swapTxtResolverForTesting(previousResolver);
});

function call(ctx: TestContext, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: orgOnlyHeaders(ctx, body ? { "Content-Type": "application/json" } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** A CLI login (device flow approved by the session in `cookie`): its refresh token. */
async function cliRefreshTokenFor(cookie: string): Promise<string> {
  const { ensureCliClient } =
    await import("../../../apps/api/src/modules/oidc/services/ensure-cli-client.ts");
  await ensureCliClient();
  const code = (await (
    await client.post("/device/code", {
      client_id: "appstrate-cli",
      scope: "openid profile email offline_access",
    })
  ).json()) as { device_code: string; user_code: string };
  await app.request(`/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`, {
    headers: { Cookie: cookie },
  });
  expect((await client.post("/device/approve", { userCode: code.user_code }, cookie)).status).toBe(
    200,
  );
  await db
    .update(deviceCode)
    .set({ lastPolledAt: new Date(Date.now() - 10_000) })
    .where(eq(deviceCode.deviceCode, code.device_code));
  const res = await client.post("/cli/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: code.device_code,
    client_id: "appstrate-cli",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { refresh_token: string }).refresh_token;
}

function refreshCli(refreshToken: string): Promise<Response> {
  return client.post("/cli/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: "appstrate-cli",
  });
}

async function sessionIdOf(userId: string): Promise<string> {
  const [row] = await db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
  return row!.id;
}

describe("/api/org-sso", () => {
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    txtRecords = {};
    owner = await createTestContext();
  });

  describe("who", () => {
    it("lets an admin read and refuses an admin any change", async () => {
      const admin = await memberContext(owner, "admin");
      expect((await call(admin, "GET", "/api/org-sso")).status).toBe(200);
      expect((await call(admin, "POST", "/api/org-sso/domains", { domain: DOMAIN })).status).toBe(
        403,
      );
    });

    it("refuses a member even the read", async () => {
      const member = await memberContext(owner, "member");
      expect((await call(member, "GET", "/api/org-sso")).status).toBe(403);
    });

    it("refuses an API key, even one created by an owner", async () => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: owner.user.id,
        name: "sso-key",
        scopes: ["org:read"],
      });
      const res = await app.request("/api/org-sso/domains", {
        method: "POST",
        headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain: DOMAIN }),
      });
      expect(res.status).toBe(403);
    });

    it("never gives the join role a privileged value", async () => {
      const res = await call(owner, "PATCH", "/api/org-sso", { join_role: "admin" });
      expect(res.status).toBe(400);
      const ok = await call(owner, "PATCH", "/api/org-sso", { join_role: "guest" });
      expect(((await ok.json()) as Settings).join_role).toBe("guest");
    });
  });

  describe("domains", () => {
    it("verifies a domain by its TXT record, and only by the right value", async () => {
      const added = (await (
        await call(owner, "POST", "/api/org-sso/domains", { domain: "Corp.Test." })
      ).json()) as Settings;
      const domain = added.domains[0]!;
      expect(domain).toMatchObject({
        domain: DOMAIN,
        verified: false,
        txt_record_name: `_appstrate.${DOMAIN}`,
      });
      expect(domain.txt_record_value).toStartWith("appstrate-domain-verification=");

      const missing = await call(owner, "POST", `/api/org-sso/domains/${domain.id}/verify`);
      expect(missing.status).toBe(422);
      txtRecords[domain.txt_record_name] = [["appstrate-domain-verification=wrong"]];
      expect((await call(owner, "POST", `/api/org-sso/domains/${domain.id}/verify`)).status).toBe(
        422,
      );

      // A long value split across character-strings is joined.
      const value = domain.txt_record_value;
      txtRecords[domain.txt_record_name] = [["v=spf1 -all"], [value.slice(0, 20), value.slice(20)]];
      const verified = await call(owner, "POST", `/api/org-sso/domains/${domain.id}/verify`);
      expect(verified.status).toBe(200);
      expect(((await verified.json()) as Settings).domains[0]!.verified).toBe(true);
    });

    it("reports a resolver failure as such, not as a missing record", async () => {
      const added = (await (
        await call(owner, "POST", "/api/org-sso/domains", { domain: DOMAIN })
      ).json()) as Settings;
      const previous = swapTxtResolverForTesting(async () => {
        throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      });
      try {
        const res = await call(
          owner,
          "POST",
          `/api/org-sso/domains/${added.domains[0]!.id}/verify`,
        );
        expect(res.status).toBe(502);
      } finally {
        swapTxtResolverForTesting(previous);
      }
    });

    it("refuses a value that is not a domain", async () => {
      for (const domain of ["localhost", "a@b.test", "10.0.0.1", "-bad.test"]) {
        expect((await call(owner, "POST", "/api/org-sso/domains", { domain })).status).toBe(400);
      }
    });

    it("gives a verified domain to one organization of the instance", async () => {
      const other = await createTestContext();
      const mine = (await (
        await call(owner, "POST", "/api/org-sso/domains", { domain: DOMAIN })
      ).json()) as Settings;
      const theirs = (await (
        await call(other, "POST", "/api/org-sso/domains", { domain: DOMAIN })
      ).json()) as Settings;
      // Both may claim it while nobody has proven it; each gets its own token.
      expect(mine.domains[0]!.txt_record_value).not.toBe(theirs.domains[0]!.txt_record_value);
      txtRecords[`_appstrate.${DOMAIN}`] = [
        [mine.domains[0]!.txt_record_value],
        [theirs.domains[0]!.txt_record_value],
      ];
      expect(
        (await call(owner, "POST", `/api/org-sso/domains/${mine.domains[0]!.id}/verify`)).status,
      ).toBe(200);
      const second = await call(
        other,
        "POST",
        `/api/org-sso/domains/${theirs.domains[0]!.id}/verify`,
      );
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("domain_taken");
      // And nobody can claim it afresh once it is proven.
      const third = await createTestContext();
      expect((await call(third, "POST", "/api/org-sso/domains", { domain: DOMAIN })).status).toBe(
        409,
      );
    });

    it("keeps one organization's domains out of another's reach", async () => {
      const other = await createTestContext();
      const mine = (await (
        await call(owner, "POST", "/api/org-sso/domains", { domain: DOMAIN })
      ).json()) as Settings;
      const id = mine.domains[0]!.id;
      expect(
        ((await (await call(other, "GET", "/api/org-sso")).json()) as Settings).domains,
      ).toHaveLength(0);
      expect((await call(other, "POST", `/api/org-sso/domains/${id}/verify`)).status).toBe(404);
      expect((await call(other, "DELETE", `/api/org-sso/domains/${id}`)).status).toBe(404);
      expect(
        ((await (await call(owner, "GET", "/api/org-sso")).json()) as Settings).domains,
      ).toHaveLength(1);
    });
  });

  describe("tenant", () => {
    it("binds only the tenant of the owner's own recent Microsoft sign-in", async () => {
      const refused = await call(owner, "POST", "/api/org-sso/tenant");
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe("microsoft_session_required");

      const sessionId = await sessionIdOf(owner.user.id);
      await seedMicrosoftSession(sessionId, owner.user.id, TENANT, 20 * 60 * 1000);
      expect((await call(owner, "POST", "/api/org-sso/tenant")).status).toBe(409);
    });

    it("binds it, and reports the caller's own tenant", async () => {
      await seedMicrosoftSession(await sessionIdOf(owner.user.id), owner.user.id, TENANT);
      const res = await call(owner, "POST", "/api/org-sso/tenant");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ tenant_id: TENANT, caller_tenant_id: TENANT });
    });

    it("does not let a session of another user stand for the caller's", async () => {
      const someone = await createTestUser();
      await seedMicrosoftSession(await sessionIdOf(owner.user.id), someone.id, TENANT);
      expect((await call(owner, "POST", "/api/org-sso/tenant")).status).toBe(409);
    });
  });

  describe("enforcement", () => {
    it("is refused before the tenant and a verified domain exist", async () => {
      const res = await call(owner, "POST", "/api/org-sso/enforcement");
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("sso_not_ready");
    });

    it("is refused from a session the bound tenant did not open (anti-lockout)", async () => {
      await seedSso({ orgId: owner.orgId });
      const fromPassword = await call(owner, "POST", "/api/org-sso/enforcement");
      expect(fromPassword.status).toBe(409);
      expect(((await fromPassword.json()) as { code: string }).code).toBe(
        "microsoft_session_required",
      );

      await seedMicrosoftSession(await sessionIdOf(owner.user.id), owner.user.id, OTHER_TENANT);
      expect((await call(owner, "POST", "/api/org-sso/enforcement")).status).toBe(409);
    });

    it("ends every other session of the domain's accounts, keeps the caller's and the others'", async () => {
      await seedSso({ orgId: owner.orgId });
      await seedMicrosoftSession(await sessionIdOf(owner.user.id), owner.user.id, TENANT);
      const atDomain = await createTestUser({ email: `alice@${DOMAIN}` });
      const elsewhere = await createTestUser({ email: "bob@elsewhere.test" });
      // A second session of the owner, opened elsewhere.
      const ownerOther = await client.signIn(owner.user.email, "TestPassword123!");

      const res = await call(owner, "POST", "/api/org-sso/enforcement");
      expect(res.status).toBe(200);
      expect(((await res.json()) as Settings).enforced).toBe(true);

      expect(await client.profileStatus(atDomain.cookie)).toBe(401);
      expect(await client.profileStatus(elsewhere.cookie)).toBe(200);
      expect(await client.profileStatus(owner.cookie)).toBe(200);
      // The owner's address is not at the domain: their other session is not the domain's.
      expect(await client.profileStatus(ownerOther)).toBe(200);
    });

    it("ends an owner's other sessions at the domain, but never the one enforcing", async () => {
      await truncateAll();
      owner = await createTestContext({ email: `owner@${DOMAIN}` });
      await seedSso({ orgId: owner.orgId });
      const enforcing = await sessionIdOf(owner.user.id);
      await seedMicrosoftSession(enforcing, owner.user.id, TENANT);
      await db.insert(session).values({
        id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        userId: owner.user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        realm: "platform",
      });
      expect((await call(owner, "POST", "/api/org-sso/enforcement")).status).toBe(200);
      const left = await db.select().from(session).where(eq(session.userId, owner.user.id));
      expect(left.map((s) => s.id)).toEqual([enforcing]);
      expect(await client.profileStatus(owner.cookie)).toBe(200);
    });

    it("holds the tenant and the verified domains until it is lifted", async () => {
      const { domainIds } = await seedSso({ orgId: owner.orgId, enforced: true });
      for (const [method, path] of [
        ["DELETE", "/api/org-sso/tenant"],
        ["DELETE", `/api/org-sso/domains/${domainIds[0]}`],
      ] as const) {
        const res = await call(owner, method, path);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe("sso_enforced");
      }
      expect((await call(owner, "DELETE", "/api/org-sso/enforcement")).status).toBe(200);
      const unlinked = await call(owner, "DELETE", "/api/org-sso/tenant");
      expect(((await unlinked.json()) as Settings).tenant_id).toBeNull();
    });

    it("ends the domain's CLI and OAuth tokens too, not only sessions", async () => {
      await seedSso({ orgId: owner.orgId });
      await seedMicrosoftSession(await sessionIdOf(owner.user.id), owner.user.id, TENANT);
      const atDomain = await createTestUser({ email: `alice@${DOMAIN}` });
      const elsewhere = await createTestUser({ email: "bob@elsewhere.test" });
      const domainToken = await cliRefreshTokenFor(atDomain.cookie);
      const otherToken = await cliRefreshTokenFor(elsewhere.cookie);

      expect((await call(owner, "POST", "/api/org-sso/enforcement")).status).toBe(200);

      expect((await refreshCli(domainToken)).status).toBeGreaterThanOrEqual(400);
      expect((await refreshCli(otherToken)).status).toBe(200);
    });

    it("ends the access of a domain verified while enforcement is on", async () => {
      await seedSso({ orgId: owner.orgId, enforced: true });
      const added = (await (
        await call(owner, "POST", "/api/org-sso/domains", { domain: "later.test" })
      ).json()) as Settings;
      const later = added.domains.find((d) => d.domain === "later.test")!;
      const atLater = await createTestUser({ email: "carol@later.test" });
      const token = await cliRefreshTokenFor(atLater.cookie);
      txtRecords[later.txt_record_name] = [[later.txt_record_value]];

      expect((await call(owner, "POST", `/api/org-sso/domains/${later.id}/verify`)).status).toBe(
        200,
      );
      expect(await client.profileStatus(atLater.cookie)).toBe(401);
      expect((await refreshCli(token)).status).toBeGreaterThanOrEqual(400);
    });

    it("finishes the revocation when enforcement is applied again", async () => {
      await seedSso({ orgId: owner.orgId });
      await seedMicrosoftSession(await sessionIdOf(owner.user.id), owner.user.id, TENANT);
      expect((await call(owner, "POST", "/api/org-sso/enforcement")).status).toBe(200);
      // A session a revocation cut short left behind.
      const survivor = await createTestUser({ email: `dave@${DOMAIN}` });
      expect(await client.profileStatus(survivor.cookie)).toBe(200);

      const again = await call(owner, "POST", "/api/org-sso/enforcement");
      expect(again.status).toBe(200);
      expect(await client.profileStatus(survivor.cookie)).toBe(401);
      expect(await client.profileStatus(owner.cookie)).toBe(200);
      const actions = (
        await db
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(eq(auditEvents.orgId, owner.orgId))
      ).map((row) => row.action);
      expect(actions).toContain("org_sso.enforcement_reapplied");
    });

    it("audits every change", async () => {
      await seedSso({ orgId: owner.orgId, tenantId: null, domains: [] });
      await seedMicrosoftSession(await sessionIdOf(owner.user.id), owner.user.id, TENANT);
      await call(owner, "POST", "/api/org-sso/tenant");
      const added = (await (
        await call(owner, "POST", "/api/org-sso/domains", { domain: DOMAIN })
      ).json()) as Settings;
      txtRecords[`_appstrate.${DOMAIN}`] = [[added.domains[0]!.txt_record_value]];
      await call(owner, "POST", `/api/org-sso/domains/${added.domains[0]!.id}/verify`);
      await call(owner, "PATCH", "/api/org-sso", { join_role: "guest" });
      await call(owner, "POST", "/api/org-sso/enforcement");
      await call(owner, "DELETE", "/api/org-sso/enforcement");
      const actions = (
        await db
          .select({ action: auditEvents.action, actorId: auditEvents.actorId })
          .from(auditEvents)
          .where(and(eq(auditEvents.orgId, owner.orgId), eq(auditEvents.resourceType, "org_sso")))
      ).map((row) => row.action);
      expect(actions.sort()).toEqual(
        [
          "org_sso.domain_added",
          "org_sso.domain_verified",
          "org_sso.enforced",
          "org_sso.enforcement_lifted",
          "org_sso.join_role_updated",
          "org_sso.tenant_linked",
        ].sort(),
      );
    });
  });
});
