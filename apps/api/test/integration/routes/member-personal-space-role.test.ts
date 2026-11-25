// SPDX-License-Identifier: Apache-2.0

/**
 * `PUT|DELETE /api/orgs/{orgId}/members/{userId}/personal-space-role` (RBAC spec §3.6): a
 * member's own role in their personal space, overriding the org's `personal_space_role`.
 * Stored as the owner's `space_members` row on that space; the claims are what the door
 * writes and refuses, what the member then holds, and what drops the override.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { auditEvents, spaceMembers, spaces } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import {
  createTestContext,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { loopbackHeaders } from "../../helpers/loopback.ts";
import { seedSpaceRole } from "../../helpers/seed.ts";
import { listSpaceMembers } from "../../../src/services/space-members.ts";
import { knownSpaceLevelPermissions, orgPermissions } from "../../../src/lib/permissions.ts";

const app = getTestApp();

const json = { "Content-Type": "application/json" };
const DELETES = ["agents:delete", "skills:delete", "integrations:delete", "schedules:delete"];

interface ListedSpace {
  id: string;
  personal: boolean;
  role: { kind: string; key: string; name: string } | null;
  permissions: string[];
}

interface MemberDto {
  userId: string;
  personal_space_role: { preset_role: string } | { custom_role_id: string } | null;
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

async function personalOf(ctx: TestContext): Promise<ListedSpace> {
  const res = await app.request("/api/spaces", { headers: orgOnlyHeaders(ctx) });
  expect(res.status, await res.clone().text()).toBe(200);
  const own = ((await res.json()) as { data: ListedSpace[] }).data.filter((s) => s.personal);
  expect(own).toHaveLength(1);
  return own[0]!;
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

/** The override rows the user holds on their own personal spaces, live or orphaned. */
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
    for (const permission of ["agents:read", ...DELETES]) {
      expect(own.permissions).toContain(permission);
    }
    for (const permission of ["agents:run", "agents:write", "studio:read", "runs:read"]) {
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

  it("PUT gives a guest their override instead of plain operator", async () => {
    expect((await putOverride(owner, guest.user.id, { preset_role: "builder" })).status).toBe(200);
    const own = await personalOf(guest);
    expect(own.role).toMatchObject({ key: "builder" });
    for (const permission of DELETES) expect(own.permissions).toContain(permission);
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

  // A custom override, not `viewer`: the `viewer` preset grants `studio:read` (every `:read`
  // of `operator`), so only a bundle can show the Studio withheld.
  it("an override withholding studio:read reads the same through the chat's loopback bearer", async () => {
    const role = await seedSpaceRole({
      orgId: owner.orgId,
      key: "reader",
      name: "Reader",
      permissions: ["agents:read"],
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

  it("a demotion to guest drops the override: the guest holds the guest default", async () => {
    expect((await putOverride(owner, member.user.id, { preset_role: "builder" })).status).toBe(200);
    const demoted = await app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
      method: "PUT",
      headers: { Cookie: owner.cookie, ...json },
      body: JSON.stringify({ role: "guest" }),
    });
    expect(demoted.status, await demoted.clone().text()).toBe(200);
    expect(((await demoted.json()) as MemberDto).personal_space_role).toBeNull();
    expect(await overrideRows(owner.orgId, member.user.id)).toEqual([]);

    // The org default is absent (admin), which a guest holds as plain operator.
    const own = await personalOf(member);
    expect(own.role).toMatchObject({ kind: "preset", key: "operator" });
    expect(own.permissions).not.toContain("agents:write");
    for (const permission of DELETES) expect(own.permissions).not.toContain(permission);
    expect((await memberInList(owner, member.user.id)).personal_space_role).toBeNull();
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
    for (const m of members) expect(m.personal_space_role).toBeNull();
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
