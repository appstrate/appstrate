// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/{orgId}/personal-space-role/impact` (RBAC spec §3.6): what a candidate
 * `personal_space_role` would stop. The claims: who is counted (a member or guest following the
 * default, with an enabled schedule they run in their own personal space), who is not (an
 * override, an owner or admin, a disabled schedule), that a role granting `agents:run` stops
 * nothing, and how the door refuses (foreign role, missing guard, malformed `role`).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { personalOf } from "../../helpers/personal-space.ts";
import { seedPackage, seedSchedule, seedSpaceMember, seedSpaceRole } from "../../helpers/seed.ts";

const app = getTestApp();

/** `role` is a preset key or a custom role id; each goes in its own query parameter. */
function impact(actor: TestContext, role: string) {
  const param = role.startsWith("srl_") ? "custom_role_id" : "preset_role";
  return app.request(
    `/api/orgs/${actor.orgId}/personal-space-role/impact?${param}=${encodeURIComponent(role)}`,
    { headers: { Cookie: actor.cookie } },
  );
}

async function impactOf(actor: TestContext, role: string) {
  const res = await impact(actor, role);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { schedules: number; members: number };
}

describe("GET /api/orgs/{orgId}/personal-space-role/impact", () => {
  let owner: TestContext;
  let agentId: string;

  /** An enabled (or not) schedule `ctx` runs as themselves in their own personal space. */
  async function scheduleInOwnSpace(ctx: TestContext, enabled = true): Promise<string> {
    const personalId = (await personalOf(ctx)).id;
    await seedSchedule({
      packageId: agentId,
      orgId: owner.orgId,
      spaceId: personalId,
      userId: ctx.user.id,
      enabled,
    });
    return personalId;
  }

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "impact" });
    agentId = `@${owner.org.slug}/scheduled`;
    await seedPackage({
      id: agentId,
      orgId: owner.orgId,
      type: "agent",
      homeSpaceId: owner.defaultSpaceId,
    });
  });

  it("counts a member following the default under a preset without agents:run", async () => {
    const member = await memberContext(owner, "member");
    await scheduleInOwnSpace(member);
    await scheduleInOwnSpace(member);
    expect(await impactOf(owner, "viewer")).toEqual({ schedules: 2, members: 1 });
  });

  it("leaves out a member with an override of their own", async () => {
    const member = await memberContext(owner, "member");
    const personalId = await scheduleInOwnSpace(member);
    await seedSpaceMember({ spaceId: personalId, userId: member.user.id, presetRole: "operator" });
    expect(await impactOf(owner, "viewer")).toEqual({ schedules: 0, members: 0 });
  });

  it("leaves out an org admin, who always holds admin there", async () => {
    const admin = await memberContext(owner, "admin");
    await scheduleInOwnSpace(admin);
    await scheduleInOwnSpace(owner);
    expect(await impactOf(owner, "viewer")).toEqual({ schedules: 0, members: 0 });
  });

  it("leaves out a disabled schedule", async () => {
    const member = await memberContext(owner, "member");
    await scheduleInOwnSpace(member, false);
    expect(await impactOf(owner, "viewer")).toEqual({ schedules: 0, members: 0 });
  });

  it("counts a guest, and each owner once", async () => {
    const member = await memberContext(owner, "member");
    const guest = await memberContext(owner, "guest");
    await scheduleInOwnSpace(member);
    await scheduleInOwnSpace(guest);
    await scheduleInOwnSpace(guest);
    expect(await impactOf(owner, "viewer")).toEqual({ schedules: 3, members: 2 });
  });

  it("stops nothing under a preset granting agents:run", async () => {
    const member = await memberContext(owner, "member");
    const guest = await memberContext(owner, "guest");
    await scheduleInOwnSpace(member);
    await scheduleInOwnSpace(guest);
    expect(await impactOf(owner, "operator")).toEqual({ schedules: 0, members: 0 });
  });

  it("counts under a custom role of the org without agents:run", async () => {
    const member = await memberContext(owner, "member");
    await scheduleInOwnSpace(member);
    const readOnly = await seedSpaceRole({ orgId: owner.orgId, permissions: ["agents:read"] });
    const runs = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["agents:read", "agents:run"],
    });
    expect(await impactOf(owner, readOnly.id)).toEqual({ schedules: 1, members: 1 });
    expect(await impactOf(owner, runs.id)).toEqual({ schedules: 0, members: 0 });
  });

  it("404s a custom role of another organization, naming the parameter", async () => {
    const other = await createTestContext({ orgSlug: "elsewhere" });
    const foreign = await seedSpaceRole({ orgId: other.orgId, permissions: ["agents:read"] });
    const res = await impact(owner, foreign.id);
    await expectProblem(res, 404, { code: "not_found", param: "custom_role_id" });
  });

  it("403s a caller without org:settings", async () => {
    const member = await memberContext(owner, "member");
    const res = await impact(member, "viewer");
    expect(res.status, await res.clone().text()).toBe(403);
  });

  it("400s a role that is neither a preset nor a custom role id", async () => {
    expect((await impact(owner, "superuser")).status).toBe(400);
    const missing = await app.request(`/api/orgs/${owner.orgId}/personal-space-role/impact`, {
      headers: { Cookie: owner.cookie },
    });
    expect(missing.status).toBe(400);
  });

  it("400s the retired bare `role` parameter and a query naming both references", async () => {
    const get = (query: string) =>
      app.request(`/api/orgs/${owner.orgId}/personal-space-role/impact?${query}`, {
        headers: { Cookie: owner.cookie },
      });
    expect((await get("role=viewer")).status).toBe(400);
    const own = await seedSpaceRole({ orgId: owner.orgId });
    expect((await get(`preset_role=viewer&custom_role_id=${own.id}`)).status).toBe(400);
  });
});
