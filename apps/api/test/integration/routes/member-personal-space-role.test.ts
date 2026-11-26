// SPDX-License-Identifier: Apache-2.0

/**
 * `PUT|DELETE /api/orgs/{orgId}/members/{userId}/personal-space-role` (RBAC spec §3.6): a
 * member's own role in their personal space, overriding the org's `personal_space_role`.
 * Stored as the owner's `space_members` row on that space; the claims are what the door
 * writes and refuses, what the member then holds, and what drops the override.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { auditEvents, organizations, spaceMembers, spaces } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { loopbackHeaders } from "../../helpers/loopback.ts";
import { DELETES, personalOf, type ListedSpace } from "../../helpers/personal-space.ts";
import { seedSpaceRole } from "../../helpers/seed.ts";
import { listSpaceMembers } from "../../../src/services/space-members.ts";
import { knownSpaceLevelPermissions, orgPermissions } from "../../../src/lib/permissions.ts";

const app = getTestApp();

const json = { "Content-Type": "application/json" };

interface MemberDto {
  userId: string;
  personal_space_role: { preset_role: string } | { custom_role_id: string } | null;
  personal_space_default_role: { kind: string; key: string; name: string } | null;
}

const overrideUrl = (ctx: TestContext, userId: string) =>
  `/api/orgs/${ctx.orgId}/members/${userId}/personal-space-role`;

function putOverride(actor: TestContext, userId: string, body: Record<string, unknown>) {
  return app.request(overrideUrl(actor, userId), {
    method: "PUT",
    headers: { Cookie: actor.cookie, ...json },
    body: JSON.stringify(body),
  });
}

function clearOverride(actor: TestContext, userId: string) {
  return app.request(overrideUrl(actor, userId), {
    method: "DELETE",
    headers: { Cookie: actor.cookie },
  });
}

async function memberInList(owner: TestContext, userId: string): Promise<MemberDto> {
  const res = await app.request(`/api/orgs/${owner.orgId}`, { headers: { Cookie: owner.cookie } });
  expect(res.status).toBe(200);
  const found = ((await res.json()) as { members: MemberDto[] }).members.find(
    (m) => m.userId === userId,
  );
  expect(found).toBeDefined();
  return found!;
}

/** The override rows the user holds on their own personal spaces. */
async function overrideRows(orgId: string, userId: string) {
  return db
    .select({ presetRole: spaceMembers.presetRole, customRoleId: spaceMembers.customRoleId })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(
      and(eq(spaces.orgId, orgId), eq(spaces.ownerUserId, userId), eq(spaceMembers.userId, userId)),
    );
}

describe("member personal-space role override", () => {
  let owner: TestContext;
  let admin: TestContext;
  let member: TestContext;
  let guest: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "override" });
    admin = await memberContext(owner, "admin");
    member = await memberContext(owner, "member");
    guest = await memberContext(owner, "guest");
  });

  it("PUT a preset: the member holds it plus the floor, echoed on the member DTO and audited", async () => {
    const res = await putOverride(owner, member.user.id, { preset_role: "viewer" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as MemberDto).personal_space_role).toEqual({
      preset_role: "viewer",
    });

    const own = await personalOf(member);
    expect(own.role).toMatchObject({ kind: "preset", key: "viewer" });
    for (const permission of DELETES) expect(own.permissions).toContain(permission);
    expect(own.permissions).not.toContain("agents:write");

    expect((await memberInList(owner, member.user.id)).personal_space_role).toEqual({
      preset_role: "viewer",
    });
    const [audit] = await db
      .select({ before: auditEvents.before, after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "org.member_personal_space_role_updated"));
    expect(audit).toEqual({
      before: null,
      after: { presetRole: "viewer", customRoleId: null },
    });
  });

  it("PUT wins over the org default, and replaces a previous override", async () => {
    await app.request(`/api/orgs/${owner.orgId}/settings`, {
      method: "PATCH",
      headers: { Cookie: owner.cookie, ...json },
      body: JSON.stringify({ personal_space_role: "operator" }),
    });
    expect((await personalOf(member)).role).toMatchObject({ key: "operator" });

    expect((await putOverride(owner, member.user.id, { preset_role: "builder" })).status).toBe(200);
    expect((await personalOf(member)).role).toMatchObject({ key: "builder" });

    expect((await putOverride(admin, member.user.id, { preset_role: "admin" })).status).toBe(200);
    const own = await personalOf(member);
    expect(own.role).toMatchObject({ key: "admin" });
    expect(own.permissions).toContain("agents:write");
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([
      { presetRole: "admin", customRoleId: null },
    ]);
  });

  it("PUT a custom role of the org; 404 for another org's role", async () => {
    const role = await seedSpaceRole({
      orgId: owner.orgId,
      key: "reader",
      name: "Reader",
      permissions: ["agents:read"],
    });
    const res = await putOverride(owner, member.user.id, { custom_role_id: role.id });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as MemberDto).personal_space_role).toEqual({
      custom_role_id: role.id,
    });
    const own = await personalOf(member);
    expect(own.role).toMatchObject({ kind: "custom", key: "reader", name: "Reader" });
    // Created without a choice, the role shows the Studio: `studio:read` is resolved, not stored.
    for (const permission of ["agents:read", "studio:read", ...DELETES]) {
      expect(own.permissions).toContain(permission);
    }
    for (const permission of ["agents:run", "agents:write", "runs:read"]) {
      expect(own.permissions).not.toContain(permission);
    }

    const other = await createTestContext({ orgSlug: "elsewhere" });
    const foreign = await seedSpaceRole({ orgId: other.orgId });
    await expectProblem(
      await putOverride(owner, member.user.id, { custom_role_id: foreign.id }),
      404,
    );
    // The refused write left the previous override in place.
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([
      { presetRole: null, customRoleId: role.id },
    ]);
  });

  it("PUT gives a guest a role inside operator as it is, with the floor", async () => {
    expect((await putOverride(owner, guest.user.id, { preset_role: "viewer" })).status).toBe(200);
    const own = await personalOf(guest);
    expect(own.role).toMatchObject({ key: "viewer" });
    expect(own.permissions).not.toContain("agents:run");
    for (const permission of DELETES) expect(own.permissions).toContain(permission);
  });

  it("PUT refuses a guest a role holding more than operator: 409 guest_role_too_broad, nothing written", async () => {
    for (const body of [{ preset_role: "builder" }, { preset_role: "admin" }]) {
      await expectProblem(await putOverride(owner, guest.user.id, body), 409, {
        code: "guest_role_too_broad",
      });
    }
    const author = await seedSpaceRole({
      orgId: owner.orgId,
      key: "author",
      name: "Author",
      permissions: ["agents:read", "agents:write"],
    });
    await expectProblem(
      await putOverride(owner, guest.user.id, { custom_role_id: author.id }),
      409,
      {
        code: "guest_role_too_broad",
      },
    );
    expect(await overrideRows(owner.orgId, guest.user.id)).toEqual([]);
    // The same roles are fine for a member.
    expect((await putOverride(owner, member.user.id, { preset_role: "builder" })).status).toBe(200);
  });

  it("PUT provisions the personal space when the member has none yet", async () => {
    const before = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.orgId, owner.orgId), eq(spaces.ownerUserId, member.user.id)));
    expect(before).toEqual([]);

    expect((await putOverride(owner, member.user.id, { preset_role: "runner" })).status).toBe(200);
    const after = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.orgId, owner.orgId),
          eq(spaces.ownerUserId, member.user.id),
          isNull(spaces.orphanedAt),
        ),
      );
    expect(after).toHaveLength(1);
    expect((await personalOf(member)).role).toMatchObject({ key: "runner" });
  });

  it("PUT refuses an owner or admin target with 409, a stranger with 404, a bad body with 400", async () => {
    for (const target of [owner.user.id, admin.user.id]) {
      await expectProblem(await putOverride(owner, target, { preset_role: "viewer" }), 409, {
        code: "redundant_space_role",
      });
    }
    const stranger = await createTestContext({ orgSlug: "stranger" });
    await expectProblem(await putOverride(owner, stranger.user.id, { preset_role: "viewer" }), 404);
    for (const body of [
      {},
      { preset_role: "viewer", custom_role_id: "srl_11111111-1111-4111-8111-111111111111" },
      { preset_role: "owner" },
      { custom_role_id: "srl_nope" },
      { preset_role: "viewer", extra: true },
    ]) {
      expect((await putOverride(owner, member.user.id, body)).status, JSON.stringify(body)).toBe(
        400,
      );
    }
  });

  it("is refused to a caller without members:change-role", async () => {
    expect((await putOverride(member, guest.user.id, { preset_role: "admin" })).status).toBe(403);
    expect((await clearOverride(member, guest.user.id)).status).toBe(403);
  });

  it("is refused to an owner's credential whose ceiling lacks members:change-role", async () => {
    const put = (permissions: string[]) =>
      app.request(overrideUrl(owner, member.user.id), {
        method: "PUT",
        headers: {
          ...loopbackHeaders(owner, owner.orgId, { orgRole: "owner", permissions }),
          ...json,
        },
        body: JSON.stringify({ preset_role: "viewer" }),
      });
    const ceiling = [...orgPermissions("owner")].filter((p) => p !== "members:change-role");
    await expectProblem(await put(ceiling), 403);
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([]);
    // The twin: the same bearer with the permission in its ceiling writes.
    const allowed = await put([...ceiling, "members:change-role"]);
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });

  // A custom override, not `viewer`: every preset grants `studio:read`, so only a custom role
  // (`shows_studio: false`) can show the Studio withheld.
  it("an override withholding studio:read reads the same through the chat's loopback bearer", async () => {
    const role = await seedSpaceRole({
      orgId: owner.orgId,
      key: "reader",
      name: "Reader",
      permissions: ["agents:read"],
      showsStudio: false,
    });
    const put = await putOverride(owner, member.user.id, { custom_role_id: role.id });
    expect(put.status, await put.clone().text()).toBe(200);
    const res = await app.request("/api/spaces", {
      headers: loopbackHeaders(member, owner.orgId, {
        orgRole: "member",
        permissions: [...orgPermissions("member"), ...knownSpaceLevelPermissions()],
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const own = ((await res.json()) as { data: ListedSpace[] }).data.filter((s) => s.personal);
    expect(own).toHaveLength(1);
    expect(own[0]!.role).toMatchObject({ kind: "custom", key: "reader" });
    for (const permission of ["agents:read", ...DELETES]) {
      expect(own[0]!.permissions).toContain(permission);
    }
    for (const permission of ["studio:read", "agents:write", "agents:run"]) {
      expect(own[0]!.permissions).not.toContain(permission);
    }
  });

  it("lists a guest without an override in their own space as reached by default, not by org role", async () => {
    const space = await personalOf(guest);
    const [seat] = await listSpaceMembers(owner.orgId, space.id, true);
    expect(seat).toMatchObject({ userId: guest.user.id, source: "open_space" });
    expect((await putOverride(owner, guest.user.id, { preset_role: "viewer" })).status).toBe(200);
    const [explicit] = await listSpaceMembers(owner.orgId, space.id, true);
    expect(explicit).toMatchObject({ userId: guest.user.id, source: "explicit" });
  });

  it("DELETE returns the member to the org default, idempotently", async () => {
    expect((await putOverride(owner, member.user.id, { preset_role: "viewer" })).status).toBe(200);
    expect((await personalOf(member)).role).toMatchObject({ key: "viewer" });

    expect((await clearOverride(owner, member.user.id)).status).toBe(204);
    expect((await personalOf(member)).role).toMatchObject({ key: "admin" });
    expect((await memberInList(owner, member.user.id)).personal_space_role).toBeNull();
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([]);

    expect((await clearOverride(owner, member.user.id)).status).toBe(204);
    // An owner or admin holds no override: nothing to clear, still 204.
    expect((await clearOverride(owner, admin.user.id)).status).toBe(204);
    const stranger = await createTestContext({ orgSlug: "stranger-del" });
    await expectProblem(await clearOverride(owner, stranger.user.id), 404);

    const cleared = await db
      .select({ before: auditEvents.before })
      .from(auditEvents)
      .where(eq(auditEvents.action, "org.member_personal_space_role_cleared"));
    expect(cleared).toEqual([{ before: { presetRole: "viewer", customRoleId: null } }]);
  });

  it("a promotion to admin drops the override, and a demotion does not restore it", async () => {
    expect((await putOverride(owner, member.user.id, { preset_role: "viewer" })).status).toBe(200);
    const promote = (role: string) =>
      app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
        method: "PUT",
        headers: { Cookie: owner.cookie, ...json },
        body: JSON.stringify({ role }),
      });
    expect((await promote("admin")).status).toBe(200);
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([]);
    expect((await promote("member")).status).toBe(200);
    expect((await personalOf(member)).role).toMatchObject({ key: "admin" });
    expect((await memberInList(owner, member.user.id)).personal_space_role).toBeNull();
  });

  it("a demotion to guest drops an override broader than operator, and the audit traces it", async () => {
    expect((await putOverride(owner, member.user.id, { preset_role: "builder" })).status).toBe(200);
    const demoted = await app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
      method: "PUT",
      headers: { Cookie: owner.cookie, ...json },
      body: JSON.stringify({ role: "guest" }),
    });
    expect(demoted.status, await demoted.clone().text()).toBe(200);
    expect(((await demoted.json()) as MemberDto).personal_space_role).toBeNull();
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([]);

    // The org default is absent (admin), which a guest holds as operator plus the floor.
    const own = await personalOf(member);
    expect(own.role).toMatchObject({ kind: "preset", key: "operator" });
    expect(own.permissions).not.toContain("agents:write");
    for (const permission of DELETES) expect(own.permissions).toContain(permission);
    expect((await memberInList(owner, member.user.id)).personal_space_role).toBeNull();

    const [audit] = await db
      .select({ before: auditEvents.before, after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "org.member_role_updated"));
    expect(audit?.after).toEqual({
      role: "guest",
      personalSpaceRoleCleared: { presetRole: "builder", customRoleId: null },
    });
  });

  it("a change of org role that keeps no override clears nothing and says so in the audit", async () => {
    const res = await app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
      method: "PUT",
      headers: { Cookie: owner.cookie, ...json },
      body: JSON.stringify({ role: "guest" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [audit] = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "org.member_role_updated"));
    expect(audit?.after).toEqual({ role: "guest", personalSpaceRoleCleared: null });
  });

  it("a promotion to admin traces the override it dropped", async () => {
    expect((await putOverride(owner, member.user.id, { preset_role: "viewer" })).status).toBe(200);
    const res = await app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
      method: "PUT",
      headers: { Cookie: owner.cookie, ...json },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [audit] = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "org.member_role_updated"));
    expect(audit?.after).toEqual({
      role: "admin",
      personalSpaceRoleCleared: { presetRole: "viewer", customRoleId: null },
    });
  });

  it("an override of a custom role inside operator survives a demotion to guest; a broader one goes", async () => {
    const reader = await seedSpaceRole({
      orgId: owner.orgId,
      key: "reader",
      name: "Reader",
      permissions: ["agents:read", "runs:read"],
    });
    const author = await seedSpaceRole({
      orgId: owner.orgId,
      key: "author",
      name: "Author",
      permissions: ["agents:read", "agents:write"],
    });
    const demote = () =>
      app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
        method: "PUT",
        headers: { Cookie: owner.cookie, ...json },
        body: JSON.stringify({ role: "guest" }),
      });
    expect((await putOverride(owner, member.user.id, { custom_role_id: reader.id })).status).toBe(
      200,
    );
    expect((await demote()).status).toBe(200);
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([
      { presetRole: null, customRoleId: reader.id },
    ]);

    const back = await app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
      method: "PUT",
      headers: { Cookie: owner.cookie, ...json },
      body: JSON.stringify({ role: "member" }),
    });
    expect(back.status).toBe(200);
    expect((await putOverride(owner, member.user.id, { custom_role_id: author.id })).status).toBe(
      200,
    );
    expect((await demote()).status).toBe(200);
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([]);
  });

  it("exposes the role the org default alone gives each member as personal_space_default_role", async () => {
    // Absent default = admin: owner, admin and member hold admin; the guest is capped to operator.
    const byUser = async () =>
      new Map(
        (
          (await (
            await app.request(`/api/orgs/${owner.orgId}`, { headers: { Cookie: owner.cookie } })
          ).json()) as { members: MemberDto[] }
        ).members.map((m) => [m.userId, m.personal_space_default_role]),
      );
    const admin_ = { kind: "preset", key: "admin", name: "admin" };
    const before = await byUser();
    expect(before.get(owner.user.id)).toEqual(admin_);
    expect(before.get(admin.user.id)).toEqual(admin_);
    expect(before.get(member.user.id)).toEqual(admin_);
    expect(before.get(guest.user.id)).toEqual({
      kind: "preset",
      key: "operator",
      name: "operator",
    });

    // The override does not move it: it is what the DEFAULT gives, whatever they chose.
    expect((await putOverride(owner, member.user.id, { preset_role: "viewer" })).status).toBe(200);
    expect((await byUser()).get(member.user.id)).toEqual(admin_);

    const patch = (value: string) =>
      app.request(`/api/orgs/${owner.orgId}/settings`, {
        method: "PATCH",
        headers: { Cookie: owner.cookie, ...json },
        body: JSON.stringify({ personal_space_role: value }),
      });
    expect((await patch("viewer")).status).toBe(200);
    const viewerDefault = await byUser();
    expect(viewerDefault.get(member.user.id)).toEqual({
      kind: "preset",
      key: "viewer",
      name: "viewer",
    });
    expect(viewerDefault.get(guest.user.id)).toEqual({
      kind: "preset",
      key: "viewer",
      name: "viewer",
    });
    expect(viewerDefault.get(admin.user.id)).toEqual(admin_);

    // A write answers with the same field.
    const put = await putOverride(owner, guest.user.id, { preset_role: "runner" });
    expect(((await put.json()) as MemberDto).personal_space_default_role).toEqual({
      kind: "preset",
      key: "viewer",
      name: "viewer",
    });
  });

  it("reads personal_space_default_role as null when the default names no role of the org", async () => {
    // The FK keeps the named role in existence; a role of ANOTHER org is what it cannot exclude,
    // written outside the platform (the settings route refuses it).
    const other = await createTestContext({ orgSlug: "default-foreign" });
    const role = await seedSpaceRole({ orgId: other.orgId, permissions: ["agents:read"] });
    await db
      .update(organizations)
      .set({ personalSpaceRoleId: role.id })
      .where(eq(organizations.id, owner.orgId));
    const dto = await memberInList(owner, member.user.id);
    expect(dto.personal_space_default_role).toBeNull();
    // An owner or admin still holds admin.
    expect((await memberInList(owner, admin.user.id)).personal_space_default_role).toMatchObject({
      key: "admin",
    });
  });

  it("a change of org role keeps a narrower override: a viewer stays viewer as a guest and back", async () => {
    expect((await putOverride(owner, member.user.id, { preset_role: "viewer" })).status).toBe(200);
    const changeRole = (role: string) =>
      app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
        method: "PUT",
        headers: { Cookie: owner.cookie, ...json },
        body: JSON.stringify({ role }),
      });

    // viewer grants nothing a guest's plain `operator` lacks: the restriction is not lifted.
    expect((await changeRole("guest")).status).toBe(200);
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([
      { presetRole: "viewer", customRoleId: null },
    ]);
    const asGuest = await personalOf(member);
    expect(asGuest.role).toMatchObject({ kind: "preset", key: "viewer" });
    expect(asGuest.permissions).not.toContain("agents:run");
    expect((await memberInList(owner, member.user.id)).personal_space_role).toEqual({
      preset_role: "viewer",
    });

    // …nor by the way back to member, under the admin default.
    expect((await changeRole("member")).status).toBe(200);
    expect((await personalOf(member)).role).toMatchObject({ kind: "preset", key: "viewer" });
  });

  it("a promotion's audit never lists the personal space among the revoked assignments", async () => {
    expect((await putOverride(owner, member.user.id, { preset_role: "viewer" })).status).toBe(200);
    const [personal] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.orgId, owner.orgId), eq(spaces.ownerUserId, member.user.id)));
    expect(personal).toBeDefined();
    const promoted = await app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
      method: "PUT",
      headers: { Cookie: owner.cookie, ...json },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(promoted.status, await promoted.clone().text()).toBe(200);
    const [audit] = await db
      .select({ before: auditEvents.before })
      .from(auditEvents)
      .where(eq(auditEvents.action, "org.member_role_updated"));
    const revoked = (audit?.before as { revokedSpaceAssignments: { spaceId: string }[] })
      .revokedSpaceAssignments;
    expect(revoked.map((row) => row.spaceId)).not.toContain(personal!.id);
  });

  it("hides every override from a caller without members:change-role", async () => {
    expect((await putOverride(owner, guest.user.id, { preset_role: "viewer" })).status).toBe(200);
    expect((await memberInList(owner, guest.user.id)).personal_space_role).toEqual({
      preset_role: "viewer",
    });
    const res = await app.request(`/api/orgs/${owner.orgId}`, {
      headers: { Cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    const members = ((await res.json()) as { members: MemberDto[] }).members;
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(m.personal_space_role).toBeNull();
      expect(m.personal_space_default_role).toBeNull();
    }
  });

  it("leaving the organization drops the override", async () => {
    expect((await putOverride(owner, member.user.id, { preset_role: "viewer" })).status).toBe(200);
    const left = await app.request(`/api/orgs/${owner.orgId}/leave`, {
      method: "POST",
      headers: { Cookie: member.cookie },
    });
    expect(left.status, await left.clone().text()).toBe(204);
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([]);
  });
});
