// SPDX-License-Identifier: Apache-2.0

/**
 * Invitations carry space memberships (RBAC spec §5, §6.1).
 *
 * The pair that matters is invite-time validation and accept-time application:
 * an invitation is the only way someone who is not yet in the org gets a
 * `space_members` row, so both halves are asserted here — including the two
 * cases where the row is deliberately NOT written.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditEvents, spaceMembers, spaceRoles, spaces } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestOrg,
  createTestUser,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedInvitation, seedSpace, seedSpaceRole } from "../../helpers/seed.ts";
import { assertDbCount, getDbRow } from "../../helpers/assertions.ts";

const app = getTestApp();

describe("Invitation space assignments", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "assign-org" });
  });

  function invite(body: Record<string, unknown>) {
    return app.request(`/api/orgs/${ctx.orgId}/members`, {
      method: "POST",
      headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("POST /api/orgs/:orgId/members — validation", () => {
    it("refuses a guest invitation with no space (400)", async () => {
      const res = await invite({ email: "lonely@test.com", role: "guest" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("space_assignments");
    });

    it("accepts a guest invitation that names a space (201)", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Guest space" });

      const res = await invite({
        email: "guest@test.com",
        role: "guest",
        space_assignments: [{ space_id: space.id, preset_role: "viewer" }],
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { space_assignments: unknown[] };
      expect(body.space_assignments).toEqual([{ space_id: space.id, preset_role: "viewer" }]);
    });

    it("refuses an admin invitation that names a space (400)", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Admin space" });

      const res = await invite({
        email: "admin@test.com",
        role: "admin",
        space_assignments: [{ space_id: space.id, preset_role: "builder" }],
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("space_assignments");
    });

    it("accepts an admin invitation with no space (201)", async () => {
      const res = await invite({ email: "admin2@test.com", role: "admin" });
      expect(res.status).toBe(201);
    });

    it("refuses a space belonging to another org (404 naming it)", async () => {
      const other = await createTestOrg(ctx.user.id, { slug: "assign-other-space" });
      const foreign = await seedSpace({ orgId: other.org.id, name: "Elsewhere" });

      const res = await invite({
        email: "cross@test.com",
        role: "member",
        space_assignments: [{ space_id: foreign.id, preset_role: "viewer" }],
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain(foreign.id);
    });

    it("refuses a custom role belonging to another org (404 naming it)", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Mine" });
      const other = await createTestOrg(ctx.user.id, { slug: "assign-other-role" });
      const foreignRole = await seedSpaceRole({ orgId: other.org.id, key: "foreign" });

      const res = await invite({
        email: "cross-role@test.com",
        role: "member",
        space_assignments: [{ space_id: space.id, custom_role_id: foreignRole.id }],
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain(foreignRole.id);
    });

    it("accepts this org's own custom role (201)", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Mine too" });
      const role = await seedSpaceRole({ orgId: ctx.orgId, key: "auditor" });

      const res = await invite({
        email: "own-role@test.com",
        role: "member",
        space_assignments: [{ space_id: space.id, custom_role_id: role.id }],
      });

      expect(res.status).toBe(201);
    });
  });

  describe("PUT /api/orgs/:orgId/invitations/:id", () => {
    it("replaces the stored assignments", async () => {
      const first = await seedSpace({ orgId: ctx.orgId, name: "First" });
      const second = await seedSpace({ orgId: ctx.orgId, name: "Second" });
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "edit@test.com",
        invitedBy: ctx.user.id,
        spaceAssignments: [{ space_id: first.id, preset_role: "viewer" }],
      });

      const res = await app.request(`/api/orgs/${ctx.orgId}/invitations/${inv.id}`, {
        method: "PUT",
        headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "guest",
          space_assignments: [{ space_id: second.id, preset_role: "operator" }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { role: string; space_assignments: unknown[] };
      expect(body.role).toBe("guest");
      expect(body.space_assignments).toEqual([{ space_id: second.id, preset_role: "operator" }]);
    });

    it("re-checks the role rules against the stored list when the body omits it", async () => {
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "promote@test.com",
        invitedBy: ctx.user.id,
        spaceAssignments: [],
      });

      const res = await app.request(`/api/orgs/${ctx.orgId}/invitations/${inv.id}`, {
        method: "PUT",
        headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ role: "guest" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /invite/:token/accept — applying the assignments", () => {
    it("writes one space_members row per assignment, and none anywhere else", async () => {
      const granted = await seedSpace({ orgId: ctx.orgId, name: "Granted" });
      const invitee = await createTestUser({ email: "applied@test.com" });
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "applied@test.com",
        role: "guest",
        invitedBy: ctx.user.id,
        spaceAssignments: [{ space_id: granted.id, preset_role: "builder" }],
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: invitee.cookie },
      });

      expect(res.status).toBe(200);
      const row = await getDbRow(
        spaceMembers,
        and(eq(spaceMembers.spaceId, granted.id), eq(spaceMembers.userId, invitee.id))!,
      );
      expect(row.presetRole).toBe("builder");
      expect(row.customRoleId).toBeNull();
      // Attribution is the inviter, not the invitee.
      expect(row.addedBy).toBe(ctx.user.id);
      // The default space was not named, so it gets no row — a guest reaches
      // exactly the spaces the invitation listed.
      await assertDbCount(spaceMembers, eq(spaceMembers.userId, invitee.id), 1);

      const audit = await getDbRow(
        auditEvents,
        and(eq(auditEvents.action, "org.invitation_accepted"), eq(auditEvents.resourceId, inv.id))!,
      );
      expect(audit.after).toMatchObject({
        space_assignments: [{ space_id: granted.id, preset_role: "builder" }],
      });
    });

    it("applies a custom-role assignment", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Custom" });
      const role = await seedSpaceRole({ orgId: ctx.orgId, key: "reviewer" });
      const invitee = await createTestUser({ email: "custom@test.com" });
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "custom@test.com",
        role: "guest",
        invitedBy: ctx.user.id,
        spaceAssignments: [{ space_id: space.id, custom_role_id: role.id }],
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: invitee.cookie },
      });

      expect(res.status).toBe(200);
      const row = await getDbRow(
        spaceMembers,
        and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, invitee.id))!,
      );
      expect(row.customRoleId).toBe(role.id);
      expect(row.presetRole).toBeNull();
    });

    it("skips an assignment whose space was deleted, and still accepts", async () => {
      const kept = await seedSpace({ orgId: ctx.orgId, name: "Kept" });
      const doomed = await seedSpace({ orgId: ctx.orgId, name: "Doomed" });
      const invitee = await createTestUser({ email: "stale@test.com" });
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "stale@test.com",
        role: "guest",
        invitedBy: ctx.user.id,
        spaceAssignments: [
          { space_id: kept.id, preset_role: "viewer" },
          { space_id: doomed.id, preset_role: "builder" },
        ],
      });
      await db.delete(spaces).where(eq(spaces.id, doomed.id));

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: invitee.cookie },
      });

      // The invitation is spent and the membership stands...
      expect(res.status).toBe(200);
      // ...with the surviving assignment applied and the dead one dropped.
      await assertDbCount(spaceMembers, eq(spaceMembers.userId, invitee.id), 1);
      const row = await getDbRow(
        spaceMembers,
        and(eq(spaceMembers.spaceId, kept.id), eq(spaceMembers.userId, invitee.id))!,
      );
      expect(row.presetRole).toBe("viewer");

      const audit = await getDbRow(
        auditEvents,
        and(eq(auditEvents.action, "org.invitation_accepted"), eq(auditEvents.resourceId, inv.id))!,
      );
      expect(audit.after).toMatchObject({
        space_assignments: [{ space_id: kept.id, preset_role: "viewer" }],
      });
    });

    it("skips an assignment whose custom role was deleted, and still accepts", async () => {
      const space = await seedSpace({ orgId: ctx.orgId, name: "Orphaned" });
      const role = await seedSpaceRole({ orgId: ctx.orgId, key: "doomed-role" });
      const invitee = await createTestUser({ email: "stale-role@test.com" });
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "stale-role@test.com",
        role: "guest",
        invitedBy: ctx.user.id,
        spaceAssignments: [{ space_id: space.id, custom_role_id: role.id }],
      });
      await db.delete(spaceRoles).where(eq(spaceRoles.id, role.id));

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { Cookie: invitee.cookie },
      });

      expect(res.status).toBe(200);
      await assertDbCount(spaceMembers, eq(spaceMembers.userId, invitee.id), 0);
    });
  });
});
