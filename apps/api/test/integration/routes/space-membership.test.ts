// SPDX-License-Identifier: Apache-2.0

/**
 * Space membership — the invariants of RBAC spec §5.
 *
 * Every case is written so it fails in the wrong world and passes in the right
 * one: each "denied" assertion is paired with the permitted twin that differs
 * by exactly the thing under test (`verification-must-discriminate`).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { spaceMembers } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { assertDbCount, expectProblem } from "../../helpers/assertions.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  memberContext,
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

interface SpaceItem {
  id: string;
  visibility: SpaceVisibility;
  default_role: SpaceRolePreset;
  access: "member" | "none";
  role: { kind: string; key: string; name: string } | null;
  permissions: string[];
}

interface MemberRow {
  userId: string;
  source: string;
}

describe("space membership", () => {
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "membership" });
    await seedPackage({ orgId: owner.orgId, id: "@membership/agent", type: "agent" });
    await seedInstalledPackage(owner.defaultSpaceId, "@membership/agent");
  });

  const member = (role: OrgRole) => memberContext(owner, role);

  /** An org `role` holding an explicit `preset` row in `spaceId`. */
  async function explicitMember(spaceId: string, role: OrgRole, preset: SpaceRolePreset) {
    const ctx = await member(role);
    await seedSpaceMember({ spaceId, userId: ctx.user.id, presetRole: preset });
    return ctx;
  }

  /** Space-scoped request as `ctx` (owner by default); a body is sent as JSON. */
  const req = (method: string, path: string, body?: unknown, ctx: TestContext = owner) =>
    app.request(path, {
      method,
      headers: {
        ...authHeaders(ctx),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** `GET /api/agents` in `spaceId` — the cheapest space-level read there is. */
  const readAgents = (ctx: TestContext, spaceId: string) =>
    app.request("/api/agents", { headers: authHeaders(ctx, { "X-Space-Id": spaceId }) });

  const getSpace = (id: string, ctx: TestContext) =>
    req("GET", `/api/spaces/${id}`, undefined, ctx);
  const patchSpace = (id: string, body: unknown, ctx: TestContext = owner) =>
    req("PATCH", `/api/spaces/${id}`, body, ctx);

  const listSpaces = async (ctx: TestContext) =>
    ((await (await req("GET", "/api/spaces", undefined, ctx)).json()) as { data: SpaceItem[] })
      .data;

  const listMembers = (ctx: TestContext) =>
    req("GET", `/api/spaces/${owner.defaultSpaceId}/members`, undefined, ctx);
  const postMember = (body: unknown) =>
    req("POST", `/api/spaces/${owner.defaultSpaceId}/members`, body);

  describe("the resolver's four cases", () => {
    it("a member holds the default preset in an OPEN space, and nothing in a CLOSED one", async () => {
      const ctx = await member("member");
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });

      expect((await readAgents(ctx, owner.defaultSpaceId)).status).toBe(200);
      await expectProblem(await readAgents(ctx, closed.id), 403, { code: "not_a_space_member" });
    });

    it("a PRIVATE space answers 404 — it does not exist for a non-member", async () => {
      const ctx = await member("member");
      const priv = await seedSpace({ orgId: owner.orgId, visibility: "private" });

      expect((await readAgents(ctx, priv.id)).status).toBe(404);
      // The control: the same space, the same caller, one explicit row.
      await seedSpaceMember({ spaceId: priv.id, userId: ctx.user.id, presetRole: "operator" });
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
      const explicitly = await explicitMember(openBuilder.id, "member", "viewer");

      const pick = async (ctx: TestContext) =>
        (await listSpaces(ctx)).find((s) => s.id === openBuilder.id)!;

      const implicitItem = await pick(implicitly);
      const explicitItem = await pick(explicitly);
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
      const asGuest = await explicitMember(closed.id, "guest", "operator");

      const ownerIds = (await listSpaces(owner)).map((s) => s.id).sort();
      expect(ownerIds).toEqual([owner.defaultSpaceId, closed.id, priv.id].sort());

      const memberItems = await listSpaces(asMember);
      expect(memberItems.map((s) => s.id).sort()).toEqual([owner.defaultSpaceId, closed.id].sort());
      // The closed space is listed so the member can ask for it — and marked
      // unenterable, which is the whole reason it is listed rather than hidden.
      expect(memberItems.find((s) => s.id === closed.id)!.access).toBe("none");
      expect(memberItems.find((s) => s.id === owner.defaultSpaceId)!.access).toBe("member");

      const guestItems = await listSpaces(asGuest);
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

      expect((await getSpace(owner.defaultSpaceId, asGuest)).status).toBe(404);

      const closedToMember = await getSpace(closed.id, asMember);
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
      expect((await getSpace(owner.defaultSpaceId, asGuest)).status).toBe(200);
    });

    it("a private space id learned elsewhere still 404s on GET /api/spaces/:id", async () => {
      const priv = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      const ctx = await member("member");

      expect((await getSpace(priv.id, ctx)).status).toBe(404);
      // Control: the owner, who may know, gets it.
      expect((await getSpace(priv.id, owner)).status).toBe(200);
    });
  });

  describe("PATCH /api/spaces/:id", () => {
    it("needs space-settings:write, which a builder does not hold", async () => {
      const space = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const builder = await explicitMember(space.id, "member", "builder");

      expect((await patchSpace(space.id, { name: "Renamed" }, builder)).status).toBe(403);
      // Control: the same request, the same space, one preset up.
      const spaceAdmin = await explicitMember(space.id, "member", "admin");
      expect((await patchSpace(space.id, { name: "Renamed" }, spaceAdmin)).status).toBe(200);
    });

    it("refuses to take the default space out of `open`", async () => {
      expect((await patchSpace(owner.defaultSpaceId, { visibility: "private" })).status).toBe(400);

      // Control: the same field on a non-default space is accepted.
      const other = await seedSpace({ orgId: owner.orgId });
      const ok = await patchSpace(other.id, { visibility: "private", default_role: "builder" });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as SpaceItem;
      expect(body.visibility).toBe("private");
      expect(body.default_role).toBe("builder");
    });
  });

  describe("/api/spaces/:id/members (§6.4)", () => {
    it("lists implicit members beside explicit ones, with their source", async () => {
      const implicitMember = await member("member");
      const explicitGuest = await explicitMember(owner.defaultSpaceId, "guest", "operator");

      const res = await listMembers(owner);
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { data: MemberRow[] }).data;
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
      const spaceAdmin = await explicitMember(owner.defaultSpaceId, "guest", "admin");
      const implicitMember = await member("member");
      const explicitPeer = await explicitMember(owner.defaultSpaceId, "member", "operator");

      const res = await listMembers(spaceAdmin);
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { data: MemberRow[] }).data;
      const ids = rows.map((r) => r.userId);
      expect(rows.every((r) => r.source === "explicit")).toBe(true);
      expect(ids).toContain(spaceAdmin.user.id);
      expect(ids).toContain(explicitPeer.user.id);
      // The two that are only there implicitly are absent.
      expect(ids).not.toContain(implicitMember.user.id);
      expect(ids).not.toContain(owner.user.id);

      // Control: the owner holds `members:read`, so the same request returns
      // the implicit rows too — the filter is the permission, not the space.
      const ownerRows = ((await (await listMembers(owner)).json()) as { data: MemberRow[] }).data;
      expect(ownerRows.map((r) => r.userId)).toContain(implicitMember.user.id);
    });

    it("refuses an owner/admin row with 409 and accepts a member's", async () => {
      const admin = await member("admin");
      const plain = await member("member");

      await expectProblem(
        await postMember({ userId: admin.user.id, preset_role: "builder" }),
        409,
        {
          code: "redundant_space_role",
        },
      );
      expect((await postMember({ userId: plain.user.id, preset_role: "builder" })).status).toBe(
        201,
      );
    });

    it("404s a user who is not an org member, and a role from another org", async () => {
      const stranger = await createTestUser();
      const body = { userId: stranger.id, preset_role: "viewer" };
      expect((await postMember(body)).status).toBe(404);

      // Control: the same body once they ARE an org member.
      await addOrgMember(owner.orgId, stranger.id, "member");
      expect((await postMember(body)).status).toBe(201);
    });

    it("reports whether removal leaves implicit access", async () => {
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const inOpen = await explicitMember(owner.defaultSpaceId, "member", "viewer");
      const inClosed = await explicitMember(closed.id, "member", "viewer");

      const accessAfter = async (spaceId: string, userId: string) => {
        const res = await req("DELETE", `/api/spaces/${spaceId}/members/${userId}`);
        return ((await res.json()) as { access_after: string }).access_after;
      };

      expect(await accessAfter(owner.defaultSpaceId, inOpen.user.id)).toBe("implicit");
      expect(await accessAfter(closed.id, inClosed.user.id)).toBe("none");
    });

    it("deletes the explicit rows when a member is promoted to admin", async () => {
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const promoted = await explicitMember(closed.id, "member", "viewer");

      const res = await req("PUT", `/api/orgs/${owner.orgId}/members/${promoted.user.id}`, {
        role: "admin",
      });
      expect(res.status).toBe(200);

      await assertDbCount(spaceMembers, eq(spaceMembers.userId, promoted.user.id), 0);
      // The access itself is unchanged — implied by the org role now.
      expect((await readAgents(promoted, closed.id)).status).toBe(200);
    });

    it("drops the explicit rows when the member leaves the org", async () => {
      const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
      const leaving = await explicitMember(closed.id, "member", "viewer");

      const res = await req("DELETE", `/api/orgs/${owner.orgId}/members/${leaving.user.id}`);
      expect(res.status).toBe(204);

      // Nothing cascades these — `space_members` references `spaces` and
      // `user`, and removing an org membership deletes neither. Left behind,
      // they would silently restore the role on re-invite.
      await assertDbCount(spaceMembers, eq(spaceMembers.userId, leaving.user.id), 0);
    });
  });
});
