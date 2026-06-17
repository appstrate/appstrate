// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { organizationMembers, orgInvitations } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedInvitation } from "../../helpers/seed.ts";
import { assertDbHas, assertDbCount, getDbRow } from "../../helpers/assertions.ts";

const app = getTestApp();

describe("Invitations API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inviteorg" });
  });

  describe("GET /invite/:token/info (public)", () => {
    it("returns invitation info", async () => {
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "new@test.com",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/info`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.email).toBe("new@test.com");
      expect(body.is_new_user).toBe(true);
    });

    it("returns 404 for invalid token", async () => {
      const res = await app.request("/invite/nonexistent-token/info");
      expect(res.status).toBe(404);
    });

    it("returns 410 for expired invitation", async () => {
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "expired@test.com",
        invitedBy: ctx.user.id,
        expiresAt: new Date(Date.now() - 1000), // already expired
      });

      const res = await app.request(`/invite/${inv.token}/info`);
      expect(res.status).toBe(410);
    });
  });

  describe("POST /invite/:token/accept (session required)", () => {
    it("returns 401 when there is no authenticated session", async () => {
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "anon@test.com",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/accept`, { method: "POST" });

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.code).toBe("authentication_required");
    });

    it("joins the org for an authenticated user whose email matches", async () => {
      const member = await createTestUser({ email: "existing@test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "existing@test.com",
        role: "admin",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });

      expect(res.status).toBe(200);
      // Bare joined-org resource with the invitation's role.
      const body = (await res.json()) as any;
      expect(body.id).toBe(ctx.orgId);
      expect(body.slug).toBe("inviteorg");
      expect(body.role).toBe("admin");
      expect(body).not.toHaveProperty("success");

      // The membership row is actually written (not just a 200 body), with the
      // invitation's role, and the invitation is flipped to accepted.
      await assertDbHas(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, ctx.orgId),
          eq(organizationMembers.userId, member.id),
          eq(organizationMembers.role, "admin"),
        )!,
      );
      const row = await getDbRow(orgInvitations, eq(orgInvitations.id, inv.id));
      expect(row?.status).toBe("accepted");
      expect(row?.acceptedBy).toBe(member.id);
      expect(row?.acceptedAt).not.toBeNull();
    });

    it("marks the invitation accepted (and rejects a second accept with 410)", async () => {
      const member = await createTestUser({ email: "double@test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "double@test.com",
        invitedBy: ctx.user.id,
      });

      const first = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });
      expect(first.status).toBe(200);

      const second = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });
      expect(second.status).toBe(410);
    });

    it("returns 403 when the session email does not match the invitation", async () => {
      const wrongUser = await createTestUser({ email: "wrong@test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "target@test.com",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: wrongUser.cookie },
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.code).toBe("email_mismatch");
    });

    it("is idempotent when the user is already a member (keeps their existing role)", async () => {
      const member = await createTestUser({ email: "idempotent@test.com" });

      // Pre-add the user as viewer (simulates double-click / race), then invite
      // them as admin. Accepting must NOT silently downgrade or upgrade an
      // existing membership — the safe default is to keep the current role and
      // simply consume the invitation. (Re-inviting an existing member at a new
      // role is intentionally a no-op on the role to avoid an owner being
      // demoted by a stray viewer invite.)
      await addOrgMember(ctx.orgId, member.id, "viewer");

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "idempotent@test.com",
        role: "admin",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });

      // Succeeds (idempotent), not 500.
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(ctx.orgId);

      // Exactly one membership row, role unchanged, invitation consumed.
      await assertDbCount(
        organizationMembers,
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, member.id))!,
        1,
      );
      const memberRow = await getDbRow(
        organizationMembers,
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, member.id))!,
      );
      expect(memberRow?.role).toBe("viewer");
      const invRow = await getDbRow(orgInvitations, eq(orgInvitations.id, inv.id));
      expect(invRow?.status).toBe("accepted");
    });

    it("accepts a case-insensitive email match", async () => {
      const member = await createTestUser({ email: "Mixed.Case@Test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        // Invitation stores the normalized (lowercased) address.
        email: "mixed.case@test.com",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });

      expect(res.status).toBe(200);
      await assertDbHas(
        organizationMembers,
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, member.id))!,
      );
    });

    it("returns 410 when accepting an expired invitation", async () => {
      const member = await createTestUser({ email: "late@test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "late@test.com",
        invitedBy: ctx.user.id,
        expiresAt: new Date(Date.now() - 1000), // already expired
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });

      expect(res.status).toBe(410);
      const body = (await res.json()) as any;
      expect(body.code).toBe("invitation_expired");
      // Nothing was written.
      await assertDbCount(
        organizationMembers,
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, member.id))!,
        0,
      );
    });

    it("returns 410 when accepting a cancelled invitation", async () => {
      const member = await createTestUser({ email: "revoked@test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "revoked@test.com",
        invitedBy: ctx.user.id,
        status: "cancelled",
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });

      expect(res.status).toBe(410);
      const body = (await res.json()) as any;
      expect(body.code).toBe("invitation_cancelled");
    });

    it("survives two concurrent accepts: one joins, the other is 410, single membership row", async () => {
      const member = await createTestUser({ email: "race@test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "race@test.com",
        invitedBy: ctx.user.id,
      });

      const fire = () =>
        app.request(`/invite/${inv.token}/accept`, {
          method: "POST",
          headers: { Cookie: member.cookie },
        });

      const [a, b] = await Promise.all([fire(), fire()]);
      const statuses = [a.status, b.status].sort();
      // The single-use token is claimed atomically: exactly one 200, one 410.
      expect(statuses).toEqual([200, 410]);

      // No double membership, no 500.
      await assertDbCount(
        organizationMembers,
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, member.id))!,
        1,
      );
    });

    it("returns 404 for an unknown token", async () => {
      const member = await createTestUser({ email: "whoever@test.com" });
      const res = await app.request(`/invite/nonexistent-token/accept`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /invite/:token/info — is_new_user", () => {
    it("reports is_new_user=false when the invited email already has an account", async () => {
      await createTestUser({ email: "known@test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "known@test.com",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/info`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.is_new_user).toBe(false);
      expect(body.email).toBe("known@test.com");
    });
  });
});
