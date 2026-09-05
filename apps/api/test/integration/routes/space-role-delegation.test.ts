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
import { seedApiKey, seedSpace, seedSpaceMember, seedSpaceRole } from "../../helpers/seed.ts";
import { presetPermissions } from "../../../src/lib/permissions.ts";

const app = getTestApp();

interface ListedSpace {
  id: string;
  role: { key: string } | null;
}

describe("space role delegation", () => {
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "delegation" });
  });

  async function member(): Promise<TestContext> {
    const user = await createTestUser();
    await addOrgMember(owner.orgId, user.id, "member");
    return { ...owner, user, cookie: user.cookie };
  }

  async function delegated(spaceId: string, permissions: string[]): Promise<TestContext> {
    const ctx = await member();
    const role = await seedSpaceRole({ orgId: owner.orgId, permissions });
    await seedSpaceMember({
      spaceId,
      userId: ctx.user.id,
      presetRole: null,
      customRoleId: role.id,
    });
    return ctx;
  }

  function request(ctx: TestContext, path: string, method: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function roleKey(ctx: TestContext, spaceId: string): Promise<string | undefined> {
    const response = await request(ctx, "/api/spaces", "GET");
    const body = (await response.json()) as { data: ListedSpace[] };
    return body.data.find((space) => space.id === spaceId)?.role?.key;
  }

  it("an invite grant cannot replace an existing explicit role, even with a permitted bundle", async () => {
    const actor = await delegated(owner.defaultSpaceId, [
      ...presetPermissions("viewer"),
      "space-members:invite",
    ]);
    const target = await member();
    await seedSpaceMember({
      spaceId: owner.defaultSpaceId,
      userId: target.user.id,
      presetRole: "operator",
    });
    const path = `/api/spaces/${owner.defaultSpaceId}/members`;
    const body = { userId: target.user.id, preset_role: "viewer" };

    expect((await request(actor, path, "POST", body)).status).toBe(409);
    expect(await roleKey(target, owner.defaultSpaceId)).toBe("operator");
    // The same grant can add a new explicit restriction to an implicit member.
    const implicit = await member();
    expect((await request(actor, path, "POST", { ...body, userId: implicit.user.id })).status).toBe(
      201,
    );
    expect(await roleKey(implicit, owner.defaultSpaceId)).toBe("viewer");
  });

  it("invite-only authority cannot create an admin peer or promote itself through POST", async () => {
    const actor = await delegated(owner.defaultSpaceId, ["space-members:invite"]);
    const target = await member();
    for (const [userId, status] of [
      [target.user.id, 403],
      [actor.user.id, 409],
    ] as const) {
      const response = await request(actor, `/api/spaces/${owner.defaultSpaceId}/members`, "POST", {
        userId,
        preset_role: "admin",
      });
      expect(response.status).toBe(status);
    }
    expect(
      (await request(actor, `/api/spaces/${owner.defaultSpaceId}`, "PATCH", { name: "Escalated" }))
        .status,
    ).toBe(403);
    expect(await roleKey(target, owner.defaultSpaceId)).toBe("operator");
  });

  it("concurrent creates never replace the winning membership", async () => {
    const target = await member();
    const path = `/api/spaces/${owner.defaultSpaceId}/members`;
    const roles = ["viewer", "operator"] as const;
    const responses = await Promise.all(
      roles.map((preset_role) =>
        request(owner, path, "POST", { userId: target.user.id, preset_role }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = responses.findIndex((response) => response.status === 201);
    expect(await roleKey(target, owner.defaultSpaceId)).toBe(roles[winner]);
  });

  it("change-role cannot promote itself or assign a stronger custom bundle", async () => {
    const actor = await delegated(owner.defaultSpaceId, [
      ...presetPermissions("viewer"),
      "space-members:change-role",
    ]);
    const custom = await seedSpaceRole({ orgId: owner.orgId, permissions: ["agents:write"] });
    const path = `/api/spaces/${owner.defaultSpaceId}/members/${actor.user.id}`;
    expect((await request(actor, path, "PATCH", { preset_role: "admin" })).status).toBe(403);
    expect((await request(actor, path, "PATCH", { custom_role_id: custom.id })).status).toBe(403);
    expect((await request(actor, path, "PATCH", { preset_role: "viewer" })).status).toBe(200);
    expect(await roleKey(actor, owner.defaultSpaceId)).toBe("viewer");
  });

  it("removing an explicit restriction cannot reveal a stronger open-space default", async () => {
    const actor = await delegated(owner.defaultSpaceId, ["space-members:remove"]);
    const target = await member();
    await seedSpaceMember({
      spaceId: owner.defaultSpaceId,
      userId: target.user.id,
      presetRole: "viewer",
    });
    const path = `/api/spaces/${owner.defaultSpaceId}/members`;
    expect((await request(actor, `${path}/${actor.user.id}`, "DELETE")).status).toBe(403);
    expect((await request(actor, `${path}/${target.user.id}`, "DELETE")).status).toBe(403);
    expect(await roleKey(target, owner.defaultSpaceId)).toBe("viewer");
    expect((await request(owner, `${path}/${target.user.id}`, "DELETE")).status).toBe(200);
    expect(await roleKey(target, owner.defaultSpaceId)).toBe("operator");
  });

  it("removal remains permitted when it grants no access in a closed space", async () => {
    const space = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
    const actor = await delegated(space.id, ["space-members:remove"]);
    const target = await member();
    await seedSpaceMember({ spaceId: space.id, userId: target.user.id, presetRole: "viewer" });
    expect(
      (await request(actor, `/api/spaces/${space.id}/members/${target.user.id}`, "DELETE")).status,
    ).toBe(200);
    expect(await roleKey(target, space.id)).toBeUndefined();
  });

  it("settings-only authority can rename and close but cannot open a stronger default or change it", async () => {
    const space = await seedSpace({
      orgId: owner.orgId,
      visibility: "closed",
      defaultRole: "admin",
    });
    const actor = await delegated(space.id, ["space-settings:write"]);
    const path = `/api/spaces/${space.id}`;
    expect((await request(actor, path, "PATCH", { name: "Renamed" })).status).toBe(200);
    expect((await request(actor, path, "PATCH", { visibility: "open" })).status).toBe(403);
    expect((await request(actor, path, "PATCH", { default_role: "builder" })).status).toBe(403);
    expect((await request(owner, path, "PATCH", { visibility: "open" })).status).toBe(200);
    expect((await request(actor, path, "PATCH", { visibility: "private" })).status).toBe(200);
  });

  it("a delegated settings role can open a space with a default it holds", async () => {
    const space = await seedSpace({
      orgId: owner.orgId,
      visibility: "closed",
      defaultRole: "admin",
    });
    const actor = await delegated(space.id, [
      ...presetPermissions("viewer"),
      "space-settings:write",
    ]);
    const response = await request(actor, `/api/spaces/${space.id}`, "PATCH", {
      visibility: "open",
      default_role: "viewer",
    });
    expect(response.status).toBe(200);
    expect(await roleKey(await member(), space.id)).toBe("viewer");
  });

  it("a full space admin can add restrictions, promote, remove and change the default", async () => {
    const actor = await member();
    await seedSpaceMember({
      spaceId: owner.defaultSpaceId,
      userId: actor.user.id,
      presetRole: "admin",
    });
    const target = await member();
    const path = `/api/spaces/${owner.defaultSpaceId}/members`;
    expect(
      (await request(actor, path, "POST", { userId: target.user.id, preset_role: "viewer" }))
        .status,
    ).toBe(201);
    expect(await roleKey(target, owner.defaultSpaceId)).toBe("viewer");
    expect(
      (await request(actor, `${path}/${target.user.id}`, "PATCH", { preset_role: "admin" })).status,
    ).toBe(200);
    expect((await request(actor, `${path}/${target.user.id}`, "DELETE")).status).toBe(200);
    expect(
      (
        await request(actor, `/api/spaces/${owner.defaultSpaceId}`, "PATCH", {
          default_role: "admin",
        })
      ).status,
    ).toBe(200);
    expect(await roleKey(target, owner.defaultSpaceId)).toBe("admin");
  });

  it("an owner's space-bound API key does not inherit membership or settings authority", async () => {
    const target = await member();
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      createdBy: owner.user.id,
      scopes: ["spaces:read"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" };
    const membersPath = `/api/spaces/${owner.defaultSpaceId}/members`;
    const assignment = { userId: target.user.id, preset_role: "viewer" };
    const settingsPath = `/api/spaces/${owner.defaultSpaceId}`;
    const settings = { default_role: "viewer" };
    // These actions are session-only in the API-key vocabulary, so denial is
    // the route guard, before the delegation subset check.
    expect(
      (
        await app.request(membersPath, {
          method: "POST",
          headers,
          body: JSON.stringify(assignment),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(settingsPath, {
          method: "PATCH",
          headers,
          body: JSON.stringify(settings),
        })
      ).status,
    ).toBe(403);
    expect((await app.request(settingsPath, { headers })).status).toBe(200);
    expect((await request(owner, membersPath, "POST", assignment)).status).toBe(201);
    expect((await request(owner, settingsPath, "PATCH", settings)).status).toBe(200);
  });
});
