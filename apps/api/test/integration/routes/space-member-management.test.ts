// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedSpace, seedSpaceMember, seedSpaceRole } from "../../helpers/seed.ts";
import { presetPermissions } from "../../../src/lib/permissions.ts";
import type { SpaceRoleWire } from "../../../src/services/space-roles.ts";

const app = getTestApp();

describe("delegated space membership management", () => {
  let owner: TestContext;
  let guest: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "space-management" });
    const user = await createTestUser();
    await addOrgMember(owner.orgId, user.id, "guest");
    await seedSpaceMember({ spaceId: owner.defaultSpaceId, userId: user.id, presetRole: "admin" });
    guest = { ...owner, user, cookie: user.cookie };
  });

  function request(ctx: TestContext, path: string, method = "GET", body?: unknown) {
    return app.request(path, {
      method,
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("lets a guest space admin assign a custom role by exact email without an org directory", async () => {
    const target = await createTestUser({ email: "known-person@example.com" });
    await addOrgMember(owner.orgId, target.id, "guest");
    const role = await seedSpaceRole({ orgId: owner.orgId, permissions: ["agents:read"] });

    const org = await request(guest, `/api/orgs/${owner.orgId}`);
    expect(await org.json()).toMatchObject({ members: [], invitations: [] });
    expect((await request(guest, "/api/roles")).status).toBe(403);
    const catalog = await request(guest, `/api/spaces/${owner.defaultSpaceId}/roles`);
    expect(catalog.status).toBe(200);
    const listed = (await catalog.json()) as { data: SpaceRoleWire[] };
    expect(listed.data.some((r) => r.kind === "preset" && r.key === "admin")).toBe(true);
    expect(listed.data.some((r) => r.id === role.id)).toBe(true);

    const added = await request(guest, `/api/spaces/${owner.defaultSpaceId}/members`, "POST", {
      email: "  KNOWN-PERSON@EXAMPLE.COM  ",
      custom_role_id: role.id,
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ userId: target.id, custom_role_id: role.id });
    const duplicate = await request(guest, `/api/spaces/${owner.defaultSpaceId}/members`, "POST", {
      email: target.email,
      preset_role: "admin",
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "space_member_exists" });
  });

  it("keeps roles with permissions from unloaded modules assignable under their effective grants", async () => {
    const role = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["agents:read", "removed-module:read"],
    });
    const catalog = await request(guest, `/api/spaces/${owner.defaultSpaceId}/roles`);
    const { data } = (await catalog.json()) as { data: SpaceRoleWire[] };
    expect(data.some((candidate) => candidate.id === role.id)).toBe(true);
    const target = await createTestUser();
    await addOrgMember(owner.orgId, target.id, "guest");
    const added = await request(guest, `/api/spaces/${owner.defaultSpaceId}/members`, "POST", {
      email: target.email,
      custom_role_id: role.id,
    });
    expect(added.status).toBe(201);
  });

  it("returns the same 404 for unknown emails and users outside the organization", async () => {
    const outsider = await createTestUser();
    for (const email of [outsider.email, "unknown@example.com"]) {
      const response = await request(guest, `/api/spaces/${owner.defaultSpaceId}/members`, "POST", {
        email,
        preset_role: "viewer",
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        detail: "User is not a member of this organization",
      });
    }
  });

  it("requires exactly one valid user reference and preserves the role ceiling for email writes", async () => {
    for (const identity of [
      {},
      { userId: guest.user.id, email: guest.user.email },
      { email: "bad" },
    ]) {
      const response = await request(guest, `/api/spaces/${owner.defaultSpaceId}/members`, "POST", {
        ...identity,
        preset_role: "viewer",
      });
      expect(response.status).toBe(400);
    }
    const delegator = await createTestUser();
    await addOrgMember(owner.orgId, delegator.id, "guest");
    const role = await seedSpaceRole({ orgId: owner.orgId, permissions: ["space-members:invite"] });
    await seedSpaceMember({
      spaceId: owner.defaultSpaceId,
      userId: delegator.id,
      presetRole: null,
      customRoleId: role.id,
    });
    const ctx = { ...owner, user: delegator, cookie: delegator.cookie };
    const target = await createTestUser();
    await addOrgMember(owner.orgId, target.id, "guest");
    const response = await request(ctx, `/api/spaces/${owner.defaultSpaceId}/members`, "POST", {
      email: target.email,
      preset_role: "admin",
    });
    expect(response.status).toBe(403);
  });

  it("filters the catalog using the path space's effective grants", async () => {
    const targetSpace = await seedSpace({ orgId: owner.orgId, visibility: "private" });
    const permissions = [...presetPermissions("viewer"), "space-members:change-role"];
    const delegatedRole = await seedSpaceRole({ orgId: owner.orgId, permissions });
    const smallRole = await seedSpaceRole({
      orgId: owner.orgId,
      key: "reader",
      permissions: ["agents:read"],
    });
    const forbiddenRole = await seedSpaceRole({
      orgId: owner.orgId,
      key: "writer",
      permissions: ["agents:write"],
    });
    await seedSpaceMember({
      spaceId: targetSpace.id,
      userId: guest.user.id,
      presetRole: null,
      customRoleId: delegatedRole.id,
    });
    // Header names the admin space, but this catalog belongs to the path space.
    const response = await request(guest, `/api/spaces/${targetSpace.id}/roles`);
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: SpaceRoleWire[] };
    expect(data.filter((r) => r.kind === "preset").map((r) => r.key)).toEqual(["viewer"]);
    expect(data.some((r) => r.id === smallRole.id)).toBe(true);
    expect(data.some((r) => r.id === forbiddenRole.id)).toBe(false);
    expect(data.every((r) => r.permissions.every((p) => permissions.includes(p)))).toBe(true);
  });

  it("opens the catalog to settings-only editors but not to read-only members or other spaces", async () => {
    const settingsRole = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["space-settings:write"],
    });
    const target = await createTestUser();
    await addOrgMember(owner.orgId, target.id, "guest");
    await seedSpaceMember({
      spaceId: owner.defaultSpaceId,
      userId: target.id,
      presetRole: null,
      customRoleId: settingsRole.id,
    });
    const ctx = { ...owner, user: target, cookie: target.cookie };
    expect((await request(ctx, `/api/spaces/${owner.defaultSpaceId}/roles`)).status).toBe(200);
    const elsewhere = await seedSpace({ orgId: owner.orgId, visibility: "private" });
    expect((await request(ctx, `/api/spaces/${elsewhere.id}/roles`)).status).toBe(404);
    const viewer = await createTestUser();
    await addOrgMember(owner.orgId, viewer.id, "member");
    expect(
      (
        await request(
          { ...owner, user: viewer, cookie: viewer.cookie },
          `/api/spaces/${owner.defaultSpaceId}/roles`,
        )
      ).status,
    ).toBe(403);
  });
});
