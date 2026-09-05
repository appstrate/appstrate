// SPDX-License-Identifier: Apache-2.0

/**
 * Space membership — the invariants of RBAC spec §5.
 *
 * Every case is written so it fails in the wrong world and passes in the right
 * one: each "denied" assertion is paired with the permitted twin that differs
 * by exactly the thing under test (`verification-must-discriminate`).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { toRows } from "@appstrate/db/client";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedSpace,
  seedSpaceMember,
  seedPackage,
  seedInstalledPackage,
} from "../../helpers/seed.ts";
import type { OrgRole, SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";

const app = getTestApp();

/** Explicit `space_members` rows a user holds, across every space. */
async function spaceMemberCount(userId: string): Promise<number> {
  const rows = toRows<{ n: number | string }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM space_members WHERE user_id = ${userId}`),
  );
  return Number(rows[0]?.n ?? -1);
}

interface SpaceItem {
  id: string;
  visibility: SpaceVisibility;
  default_role: SpaceRolePreset;
  access: "member" | "none";
  role: { kind: string; key: string; name: string } | null;
  permissions: string[];
}

describe("space membership", () => {
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "membership" });
    await seedPackage({ orgId: owner.orgId, id: "@membership/agent", type: "agent" });
    await seedInstalledPackage(owner.defaultSpaceId, "@membership/agent");
  });

  /** A user with `role` in the org, sharing the owner's org context. */
  async function member(role: OrgRole): Promise<TestContext> {
    const user = await createTestUser();
    await addOrgMember(owner.orgId, user.id, role);
    return { ...owner, user, cookie: user.cookie };
  }

  /** `GET /api/agents` in `spaceId` — the cheapest space-level read there is. */
  async function readAgents(ctx: TestContext, spaceId: string): Promise<Response> {
    return app.request("/api/agents", {
      headers: authHeaders(ctx, { "X-Space-Id": spaceId }),
    });
  }

  describe("the resolver's four cases", () => {
    it("a member holds the default preset in an OPEN space, and nothing in a CLOSED one", async () => {
      const ctx = await member("member");
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });

      expect((await readAgents(ctx, owner.defaultSpaceId)).status).toBe(200);
      const denied = await readAgents(ctx, closed.id);
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { code: string }).code).toBe("not_a_space_member");
    });

    it("a PRIVATE space answers 404 — it does not exist for a non-member", async () => {
      const ctx = await member("member");
      const priv = await seedSpace({ orgId: owner.orgId, visibility: "private" });

      expect((await readAgents(ctx, priv.id)).status).toBe(404);
      // The control: the same space, the same caller, one explicit row.
      await seedSpaceMember({
        spaceId: priv.id,
        userId: ctx.user.id,
        presetRole: "operator",
      });
      expect((await readAgents(ctx, priv.id)).status).toBe(200);
    });

    it("a guest reaches nothing without a row, and exactly its row's preset with one", async () => {
      const ctx = await member("guest");
      // Even the OPEN default space, where a member would be implicit.
      expect((await readAgents(ctx, owner.defaultSpaceId)).status).toBe(403);

      await seedSpaceMember({
        spaceId: owner.defaultSpaceId,
        userId: ctx.user.id,
        presetRole: "viewer",
      });
      expect((await readAgents(ctx, owner.defaultSpaceId)).status).toBe(200);
    });

    it("an explicit row beats the open space's default", async () => {
      const openBuilder = await seedSpace({
        orgId: owner.orgId,
        visibility: "open",
        defaultRole: "builder",
      });
      const implicitly = await member("member");
      const explicitly = await member("member");
      await seedSpaceMember({
        spaceId: openBuilder.id,
        userId: explicitly.user.id,
        presetRole: "viewer",
      });

      const asBuilder = await app.request("/api/spaces", { headers: authHeaders(implicitly) });
      const asViewer = await app.request("/api/spaces", { headers: authHeaders(explicitly) });
      const pick = async (res: Response) =>
        ((await res.json()) as { data: SpaceItem[] }).data.find((s) => s.id === openBuilder.id)!;

      const implicitItem = await pick(asBuilder);
      const explicitItem = await pick(asViewer);
      expect(implicitItem.role).toEqual({ kind: "preset", key: "builder", name: "builder" });
      expect(explicitItem.role).toEqual({ kind: "preset", key: "viewer", name: "viewer" });
      // And the sets differ where the presets differ.
      expect(implicitItem.permissions).toContain("agents:write");
      expect(explicitItem.permissions).not.toContain("agents:write");
    });

    it("owner and admin run every space, including a private one they were never added to", async () => {
      const admin = await member("admin");
      const priv = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      expect((await readAgents(owner, priv.id)).status).toBe(200);
      expect((await readAgents(admin, priv.id)).status).toBe(200);
    });
  });

  describe("GET /api/spaces filtering (§6.3)", () => {
    it("shows each caller exactly the spaces they may know about", async () => {
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const priv = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      const asMember = await member("member");
      const asGuest = await member("guest");
      await seedSpaceMember({
        spaceId: closed.id,
        userId: asGuest.user.id,
        presetRole: "operator",
      });

      const list = async (ctx: TestContext) =>
        (
          (await (await app.request("/api/spaces", { headers: authHeaders(ctx) })).json()) as {
            data: SpaceItem[];
          }
        ).data;

      const ownerIds = (await list(owner)).map((s) => s.id).sort();
      expect(ownerIds).toEqual([owner.defaultSpaceId, closed.id, priv.id].sort());

      const memberItems = await list(asMember);
      expect(memberItems.map((s) => s.id).sort()).toEqual([owner.defaultSpaceId, closed.id].sort());
      // The closed space is listed so the member can ask for it — and marked
      // unenterable, which is the whole reason it is listed rather than hidden.
      expect(memberItems.find((s) => s.id === closed.id)!.access).toBe("none");
      expect(memberItems.find((s) => s.id === owner.defaultSpaceId)!.access).toBe("member");

      const guestItems = await list(asGuest);
      expect(guestItems.map((s) => s.id)).toEqual([closed.id]);
      expect(guestItems[0]!.access).toBe("member");
    });

    it("GET /:id is visible exactly when the listing would show it", async () => {
      // The by-id read and the listing share one predicate, so this is the
      // pair that would drift if they were ever split: a guest sees an OPEN
      // space in neither, a member sees a CLOSED one in both.
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const asGuest = await member("guest");
      const asMember = await member("member");

      const openToGuest = await app.request(`/api/spaces/${owner.defaultSpaceId}`, {
        headers: authHeaders(asGuest),
      });
      expect(openToGuest.status).toBe(404);

      const closedToMember = await app.request(`/api/spaces/${closed.id}`, {
        headers: authHeaders(asMember),
      });
      expect(closedToMember.status).toBe(200);
      const body = (await closedToMember.json()) as SpaceItem;
      expect(body.access).toBe("none");
      expect(body.role).toBeNull();

      // Control: one explicit row and the guest's OPEN space read succeeds.
      await seedSpaceMember({
        spaceId: owner.defaultSpaceId,
        userId: asGuest.user.id,
        presetRole: "viewer",
      });
      const withRow = await app.request(`/api/spaces/${owner.defaultSpaceId}`, {
        headers: authHeaders(asGuest),
      });
      expect(withRow.status).toBe(200);
    });

    it("a private space id learned elsewhere still 404s on GET /api/spaces/:id", async () => {
      const priv = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      const ctx = await member("member");

      const hidden = await app.request(`/api/spaces/${priv.id}`, { headers: authHeaders(ctx) });
      expect(hidden.status).toBe(404);
      // Control: the owner, who may know, gets it.
      const visible = await app.request(`/api/spaces/${priv.id}`, { headers: authHeaders(owner) });
      expect(visible.status).toBe(200);
    });
  });

  describe("PATCH /api/spaces/:id", () => {
    it("needs space-settings:write, which a builder does not hold", async () => {
      const space = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const builder = await member("member");
      await seedSpaceMember({
        spaceId: space.id,
        userId: builder.user.id,
        presetRole: "builder",
      });

      const patch = (ctx: TestContext) =>
        app.request(`/api/spaces/${space.id}`, {
          method: "PATCH",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Renamed" }),
        });

      expect((await patch(builder)).status).toBe(403);
      // Control: the same request, the same space, one preset up.
      const spaceAdmin = await member("member");
      await seedSpaceMember({
        spaceId: space.id,
        userId: spaceAdmin.user.id,
        presetRole: "admin",
      });
      expect((await patch(spaceAdmin)).status).toBe(200);
    });

    it("refuses to take the default space out of `open`", async () => {
      const res = await app.request(`/api/spaces/${owner.defaultSpaceId}`, {
        method: "PATCH",
        headers: { ...authHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "private" }),
      });
      expect(res.status).toBe(400);

      // Control: the same field on a non-default space is accepted.
      const other = await seedSpace({ orgId: owner.orgId });
      const ok = await app.request(`/api/spaces/${other.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "private", default_role: "builder" }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as SpaceItem;
      expect(body.visibility).toBe("private");
      expect(body.default_role).toBe("builder");
    });
  });

  describe("/api/spaces/:id/members (§6.4)", () => {
    it("lists implicit members beside explicit ones, with their source", async () => {
      const implicitMember = await member("member");
      const explicitGuest = await member("guest");
      await seedSpaceMember({
        spaceId: owner.defaultSpaceId,
        userId: explicitGuest.user.id,
        presetRole: "operator",
      });

      const res = await app.request(`/api/spaces/${owner.defaultSpaceId}/members`, {
        headers: authHeaders(owner),
      });
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { data: Array<{ userId: string; source: string }> }).data;
      const sourceOf = (id: string) => rows.find((r) => r.userId === id)?.source;
      expect(sourceOf(owner.user.id)).toBe("org_role");
      expect(sourceOf(implicitMember.user.id)).toBe("open_space");
      expect(sourceOf(explicitGuest.user.id)).toBe("explicit");
    });

    it("a space admin without members:read sees the explicit rows only", async () => {
      // The implicit half of this list is the ORG DIRECTORY seen through a
      // space — every org member who reaches it by role or by the open-space
      // default. A guest running one space may manage what that space granted;
      // enumerating the organization is `members:read`, which a guest has not
      // got.
      const spaceAdmin = await member("guest");
      const implicitMember = await member("member");
      const explicitPeer = await member("member");
      await seedSpaceMember({
        spaceId: owner.defaultSpaceId,
        userId: spaceAdmin.user.id,
        presetRole: "admin",
      });
      await seedSpaceMember({
        spaceId: owner.defaultSpaceId,
        userId: explicitPeer.user.id,
        presetRole: "operator",
      });

      const res = await app.request(`/api/spaces/${owner.defaultSpaceId}/members`, {
        headers: authHeaders(spaceAdmin),
      });
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { data: Array<{ userId: string; source: string }> }).data;
      const ids = rows.map((r) => r.userId);
      expect(rows.every((r) => r.source === "explicit")).toBe(true);
      expect(ids).toContain(spaceAdmin.user.id);
      expect(ids).toContain(explicitPeer.user.id);
      // The two that are only there implicitly are absent.
      expect(ids).not.toContain(implicitMember.user.id);
      expect(ids).not.toContain(owner.user.id);

      // Control: the owner holds `members:read`, so the same request returns
      // the implicit rows too — the filter is the permission, not the space.
      const asOwner = await app.request(`/api/spaces/${owner.defaultSpaceId}/members`, {
        headers: authHeaders(owner),
      });
      const ownerRows = ((await asOwner.json()) as { data: Array<{ userId: string }> }).data;
      expect(ownerRows.map((r) => r.userId)).toContain(implicitMember.user.id);
    });

    it("refuses an owner/admin row with 409 and accepts a member's", async () => {
      const admin = await member("admin");
      const plain = await member("member");
      const post = (userId: string) =>
        app.request(`/api/spaces/${owner.defaultSpaceId}/members`, {
          method: "POST",
          headers: { ...authHeaders(owner), "Content-Type": "application/json" },
          body: JSON.stringify({ userId, preset_role: "builder" }),
        });

      const refused = await post(admin.user.id);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe("redundant_space_role");
      expect((await post(plain.user.id)).status).toBe(201);
    });

    it("404s a user who is not an org member, and a role from another org", async () => {
      const stranger = await createTestUser();
      const strangerRes = await app.request(`/api/spaces/${owner.defaultSpaceId}/members`, {
        method: "POST",
        headers: { ...authHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: stranger.id, preset_role: "viewer" }),
      });
      expect(strangerRes.status).toBe(404);

      // Control: the same body once they ARE an org member.
      await addOrgMember(owner.orgId, stranger.id, "member");
      const ok = await app.request(`/api/spaces/${owner.defaultSpaceId}/members`, {
        method: "POST",
        headers: { ...authHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: stranger.id, preset_role: "viewer" }),
      });
      expect(ok.status).toBe(201);
    });

    it("reports whether removal leaves implicit access", async () => {
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const inOpen = await member("member");
      const inClosed = await member("member");
      await seedSpaceMember({
        spaceId: owner.defaultSpaceId,
        userId: inOpen.user.id,
        presetRole: "viewer",
      });
      await seedSpaceMember({
        spaceId: closed.id,
        userId: inClosed.user.id,
        presetRole: "viewer",
      });

      const remove = (spaceId: string, userId: string) =>
        app.request(`/api/spaces/${spaceId}/members/${userId}`, {
          method: "DELETE",
          headers: authHeaders(owner),
        });

      const openRes = await remove(owner.defaultSpaceId, inOpen.user.id);
      expect(((await openRes.json()) as { access_after: string }).access_after).toBe("implicit");
      const closedRes = await remove(closed.id, inClosed.user.id);
      expect(((await closedRes.json()) as { access_after: string }).access_after).toBe("none");
    });

    it("deletes the explicit rows when a member is promoted to admin", async () => {
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const promoted = await member("member");
      await seedSpaceMember({
        spaceId: closed.id,
        userId: promoted.user.id,
        presetRole: "viewer",
      });

      const res = await app.request(`/api/orgs/${owner.orgId}/members/${promoted.user.id}`, {
        method: "PUT",
        headers: { ...authHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });
      expect(res.status).toBe(200);

      expect(await spaceMemberCount(promoted.user.id)).toBe(0);
      // The access itself is unchanged — implied by the org role now.
      expect((await readAgents(promoted, closed.id)).status).toBe(200);
    });

    it("drops the explicit rows when the member leaves the org", async () => {
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const leaving = await member("member");
      await seedSpaceMember({
        spaceId: closed.id,
        userId: leaving.user.id,
        presetRole: "viewer",
      });

      const res = await app.request(`/api/orgs/${owner.orgId}/members/${leaving.user.id}`, {
        method: "DELETE",
        headers: authHeaders(owner),
      });
      expect(res.status).toBe(204);

      // Nothing cascades these — `space_members` references `spaces` and
      // `user`, and removing an org membership deletes neither. Left behind,
      // they would silently restore the role on re-invite.
      expect(await spaceMemberCount(leaving.user.id)).toBe(0);
    });
  });
});
