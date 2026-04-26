// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Phase 3 admin oversight endpoints (issue #251):
 *
 *   GET    /api/orgs/:orgId/cli-sessions
 *   DELETE /api/orgs/:orgId/cli-sessions/:familyId
 *
 * Covers:
 *   - Listing visibility scoped to current org members + cross-user info
 *   - Authorization gating (owner/admin only — member/viewer rejected)
 *   - Cross-org isolation (admin of org A cannot see org B's sessions)
 *   - Revocation by admin marks every row in the family with reason
 *     `org_admin_revoked`
 *   - Idempotent 404 on already-revoked, unknown, or out-of-org families
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  user as userTable,
  session as sessionTable,
  organizations,
  organizationMembers,
} from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";
import { cliRefreshToken, deviceCode } from "../../../schema.ts";

const app = getTestApp({ modules: [oidcModule] });

interface SignupResult {
  cookie: string;
  userId: string;
}

async function signUp(email: string, name: string): Promise<SignupResult> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Sup3rSecretPass!", name }),
  });
  expect(res.status).toBe(200);
  const match = (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  const cookie = `better-auth.session_token=${match[1]}`;
  const body = (await res.json()) as { user: { id: string } };
  await db.update(userTable).set({ realm: "platform" }).where(eq(userTable.id, body.user.id));
  await db
    .update(sessionTable)
    .set({ realm: "platform" })
    .where(eq(sessionTable.userId, body.user.id));
  return { cookie, userId: body.user.id };
}

async function loginCli(
  cookie: string,
  headers: Record<string, string> = {},
): Promise<{ familyId: string }> {
  const codeRes = await app.request("/api/auth/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "appstrate-cli",
      scope: "openid profile email offline_access",
    }),
  });
  expect(codeRes.status).toBe(200);
  const code = (await codeRes.json()) as { device_code: string; user_code: string };
  const approve = await app.request("/api/auth/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ userCode: code.user_code }),
  });
  expect(approve.status).toBe(200);
  await db
    .update(deviceCode)
    .set({ lastPolledAt: new Date(Date.now() - 10_000) })
    .where(eq(deviceCode.deviceCode, code.device_code));
  const tokenRes = await app.request("/api/auth/cli/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.device_code,
      client_id: "appstrate-cli",
    }),
  });
  expect(tokenRes.status).toBe(200);
  const body = (await tokenRes.json()) as { refresh_token: string };
  const { _hashRefreshTokenForTesting } = await import("../../../services/cli-tokens.ts");
  const [row] = await db
    .select()
    .from(cliRefreshToken)
    .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(body.refresh_token)))
    .limit(1);
  if (!row) throw new Error("token row missing");
  return { familyId: row.familyId };
}

async function addMember(
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member" | "viewer",
): Promise<void> {
  await db.insert(organizationMembers).values({ orgId, userId, role });
}

interface OrgSetup {
  orgId: string;
  owner: SignupResult;
  admin: SignupResult;
  member: SignupResult;
}

async function setupOrg(slug: string): Promise<OrgSetup> {
  // The first context.createTestContext seeds an org with an owner — we want
  // explicit control here, so we create the org row directly and attach all
  // four roles.
  const owner = await signUp(`${slug}-owner@example.com`, "Owner");
  const admin = await signUp(`${slug}-admin@example.com`, "Admin");
  const member = await signUp(`${slug}-member@example.com`, "Member");
  const [org] = await db
    .insert(organizations)
    .values({ name: `${slug} org`, slug, createdBy: owner.userId })
    .returning({ id: organizations.id });
  if (!org) throw new Error("org insert failed");
  await addMember(org.id, owner.userId, "owner");
  await addMember(org.id, admin.userId, "admin");
  await addMember(org.id, member.userId, "member");
  return { orgId: org.id, owner, admin, member };
}

describe("GET /api/orgs/:orgId/cli-sessions (#251)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "adminclisess-bootstrap" });
    await ensureCliClient();
  });

  it("admin sees every member's CLI sessions with owner identity attached", async () => {
    const { orgId, admin, member, owner } = await setupOrg("adminclisess1");

    const memberFamily = await loginCli(member.cookie, {
      "X-Appstrate-Device-Name": "member-laptop",
    });
    const ownerFamily = await loginCli(owner.cookie, {
      "X-Appstrate-Device-Name": "owner-workstation",
    });

    const res = await app.request(`/api/orgs/${orgId}/cli-sessions`, {
      method: "GET",
      headers: { Cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        familyId: string;
        userId: string;
        userEmail: string | null;
        deviceName: string | null;
      }>;
    };
    expect(body.data.length).toBe(2);
    const byFamily = new Map(body.data.map((s) => [s.familyId, s]));
    expect(byFamily.get(memberFamily.familyId)?.userId).toBe(member.userId);
    expect(byFamily.get(memberFamily.familyId)?.userEmail).toBe("adminclisess1-member@example.com");
    expect(byFamily.get(memberFamily.familyId)?.deviceName).toBe("member-laptop");
    expect(byFamily.get(ownerFamily.familyId)?.userId).toBe(owner.userId);
    expect(byFamily.get(ownerFamily.familyId)?.deviceName).toBe("owner-workstation");
  });

  it("rejects non-admin (member) callers with 403", async () => {
    const { orgId, member } = await setupOrg("adminclisess2");
    await loginCli(member.cookie);

    const res = await app.request(`/api/orgs/${orgId}/cli-sessions`, {
      method: "GET",
      headers: { Cookie: member.cookie },
    });
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const { orgId } = await setupOrg("adminclisess3");
    const res = await app.request(`/api/orgs/${orgId}/cli-sessions`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("does not leak sessions across orgs (admin of A cannot see B's sessions)", async () => {
    const a = await setupOrg("adminclisess-a");
    const b = await setupOrg("adminclisess-b");
    await loginCli(a.member.cookie);
    const bFamily = await loginCli(b.member.cookie);

    const aListedFromB = await app.request(`/api/orgs/${a.orgId}/cli-sessions`, {
      method: "GET",
      headers: { Cookie: a.admin.cookie },
    });
    const aBody = (await aListedFromB.json()) as { data: Array<{ familyId: string }> };
    // A's admin sees only A's member's session.
    expect(aBody.data.map((s) => s.familyId)).not.toContain(bFamily.familyId);
  });

  it("excludes sessions of users who left the org", async () => {
    const { orgId, member, admin } = await setupOrg("adminclisess4");
    await loginCli(member.cookie);

    // Member leaves the org.
    await db.delete(organizationMembers).where(eq(organizationMembers.userId, member.userId));

    const res = await app.request(`/api/orgs/${orgId}/cli-sessions`, {
      method: "GET",
      headers: { Cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<unknown> };
    expect(body.data.length).toBe(0);
  });
});

describe("DELETE /api/orgs/:orgId/cli-sessions/:familyId (#251)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "adminclisessrev-bootstrap" });
    await ensureCliClient();
  });

  it("owner can revoke a member's session — every row in the family carries org_admin_revoked", async () => {
    const { orgId, owner, member } = await setupOrg("adminclisessrev1");
    const { familyId } = await loginCli(member.cookie);

    const res = await app.request(`/api/orgs/${orgId}/cli-sessions/${familyId}`, {
      method: "DELETE",
      headers: { Cookie: owner.cookie },
    });
    expect(res.status).toBe(204);

    const rows = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.familyId, familyId));
    for (const r of rows) {
      expect(r.revokedAt).not.toBeNull();
      expect(r.revokedReason).toBe("org_admin_revoked");
    }
  });

  it("admin can revoke a member's session", async () => {
    const { orgId, admin, member } = await setupOrg("adminclisessrev2");
    const { familyId } = await loginCli(member.cookie);

    const res = await app.request(`/api/orgs/${orgId}/cli-sessions/${familyId}`, {
      method: "DELETE",
      headers: { Cookie: admin.cookie },
    });
    expect(res.status).toBe(204);
  });

  it("rejects member callers with 403", async () => {
    const { orgId, member } = await setupOrg("adminclisessrev3");
    const { familyId } = await loginCli(member.cookie);

    const res = await app.request(`/api/orgs/${orgId}/cli-sessions/${familyId}`, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for a family that doesn't belong to the org (cross-org isolation)", async () => {
    const a = await setupOrg("adminclisessrev-a");
    const b = await setupOrg("adminclisessrev-b");
    const { familyId: bFamily } = await loginCli(b.member.cookie);

    const res = await app.request(`/api/orgs/${a.orgId}/cli-sessions/${bFamily}`, {
      method: "DELETE",
      headers: { Cookie: a.owner.cookie },
    });
    expect(res.status).toBe(404);

    // B's family is still active.
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.familyId, bFamily))
      .limit(1);
    expect(row?.revokedAt).toBeNull();
  });

  it("returns 404 on a second revoke (already-revoked is collapsed into not-found)", async () => {
    const { orgId, owner, member } = await setupOrg("adminclisessrev4");
    const { familyId } = await loginCli(member.cookie);

    const first = await app.request(`/api/orgs/${orgId}/cli-sessions/${familyId}`, {
      method: "DELETE",
      headers: { Cookie: owner.cookie },
    });
    expect(first.status).toBe(204);
    const second = await app.request(`/api/orgs/${orgId}/cli-sessions/${familyId}`, {
      method: "DELETE",
      headers: { Cookie: owner.cookie },
    });
    expect(second.status).toBe(404);
  });

  it("returns 404 on a completely unknown familyId", async () => {
    const { orgId, owner } = await setupOrg("adminclisessrev5");
    const res = await app.request(`/api/orgs/${orgId}/cli-sessions/crf_does_not_exist`, {
      method: "DELETE",
      headers: { Cookie: owner.cookie },
    });
    expect(res.status).toBe(404);
  });
});
