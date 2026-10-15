// SPDX-License-Identifier: Apache-2.0

/**
 * `spaces[]` on the org member payload (#1992): the per-member projection of
 * `GET /api/spaces/{id}/members`.
 *
 * The contract is parity: for every caller, each member's `spaces` is exactly
 * what that caller would assemble from one per-space read of every space it may
 * read members of. Each discriminating case pairs a caller who sees a space with
 * one who does not (`verification-must-discriminate`).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedSpace, seedSpaceMember } from "../../helpers/seed.ts";

const app = getTestApp();

interface MemberSpace {
  id: string;
  name: string;
  source: string;
  role: { kind: string; key: string; name: string } | null;
}

interface OrgMember {
  userId: string;
  spaces: MemberSpace[];
}

const sorted = (spaces: MemberSpace[]) => [...spaces].sort((a, b) => a.id.localeCompare(b.id));

async function orgMembers(ctx: TestContext): Promise<OrgMember[]> {
  const res = await app.request(`/api/orgs/${ctx.orgId}`, { headers: orgOnlyHeaders(ctx) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { members: OrgMember[] }).members;
}

/** What the caller assembles today: one `/members` read per space it may read members of. */
async function perSpaceReads(ctx: TestContext): Promise<Map<string, MemberSpace[]>> {
  const spacesRes = await app.request("/api/spaces", { headers: authHeaders(ctx) });
  const spaces = (
    (await spacesRes.json()) as {
      data: { id: string; name: string; access: string; permissions: string[] }[];
    }
  ).data.filter((s) => s.access === "member" && s.permissions.includes("space-members:read"));
  const byUser = new Map<string, MemberSpace[]>();
  for (const space of spaces) {
    const res = await app.request(`/api/spaces/${space.id}/members`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: (MemberSpace & { userId: string })[] }).data;
    for (const row of rows) {
      const entry = { id: space.id, name: space.name, source: row.source, role: row.role };
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), entry]);
    }
  }
  return byUser;
}

async function expectParity(ctx: TestContext) {
  const expected = await perSpaceReads(ctx);
  const members = await orgMembers(ctx);
  expect(members.length).toBeGreaterThan(0);
  for (const member of members) {
    expect(sorted(member.spaces)).toEqual(sorted(expected.get(member.userId) ?? []));
  }
}

describe("GET /api/orgs/{orgId} — members[].spaces", () => {
  let owner: TestContext;
  let closedId: string;
  let privateId: string;
  let closedAdmin: TestContext;
  let insider: TestContext;
  let outsider: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "member-spaces" });
    const closed = await seedSpace({ orgId: owner.orgId, name: "Closed", visibility: "closed" });
    const priv = await seedSpace({ orgId: owner.orgId, name: "Private", visibility: "private" });
    closedId = closed.id;
    privateId = priv.id;

    // A member administering the closed space, one in the private space only,
    // one with explicit rows nowhere.
    closedAdmin = await memberContext(owner, "member");
    await seedSpaceMember({ spaceId: closedId, userId: closedAdmin.user.id, presetRole: "admin" });
    insider = await memberContext(owner, "member");
    await seedSpaceMember({ spaceId: privateId, userId: insider.user.id, presetRole: "viewer" });
    outsider = await memberContext(owner, "member");
  });

  it("an owner reads every member's spaces, as the per-space lists say", async () => {
    await expectParity(owner);

    const members = await orgMembers(owner);
    const insiderSpaces = members.find((m) => m.userId === insider.user.id)!.spaces;
    expect(insiderSpaces.find((s) => s.id === privateId)).toEqual({
      id: privateId,
      name: "Private",
      source: "explicit",
      role: { kind: "preset", key: "viewer", name: "viewer" },
    });
    // The open default space is reached implicitly; the closed one not at all.
    const outsiderSpaces = members.find((m) => m.userId === outsider.user.id)!.spaces;
    expect(outsiderSpaces.find((s) => s.id === owner.defaultSpaceId)?.source).toBe("open_space");
    expect(outsiderSpaces.some((s) => s.id === closedId)).toBe(false);
  });

  it("a member reads only the spaces whose member list it may read", async () => {
    await expectParity(closedAdmin);
    await expectParity(outsider);

    // The space admin sees the closed space; the outsider does not, and
    // neither sees the private space it is not in — which the owner does.
    const seenBy = async (ctx: TestContext) =>
      new Set((await orgMembers(ctx)).flatMap((m) => m.spaces.map((s) => s.id)));
    expect((await seenBy(closedAdmin)).has(closedId)).toBe(true);
    expect((await seenBy(outsider)).has(closedId)).toBe(false);
    expect((await seenBy(closedAdmin)).has(privateId)).toBe(false);
    expect((await seenBy(owner)).has(privateId)).toBe(true);
  });

  it("a personal space is listed to its owner alone", async () => {
    const personal = await seedSpace({
      orgId: owner.orgId,
      name: "Mon espace",
      visibility: "private",
      ownerUserId: insider.user.id,
    });
    const seenBy = async (ctx: TestContext) =>
      new Set((await orgMembers(ctx)).flatMap((m) => m.spaces.map((s) => s.id)));
    expect((await seenBy(insider)).has(personal.id)).toBe(true);
    expect((await seenBy(owner)).has(personal.id)).toBe(false);
    await expectParity(insider);
  });

  it("a credential pinned to a space reads that space only", async () => {
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: closedId,
      createdBy: owner.user.id,
      scopes: ["org:read", "members:read", "space-members:read"],
    });
    const res = await app.request(`/api/orgs/${owner.orgId}`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(200);
    const members = ((await res.json()) as { members: OrgMember[] }).members;
    const ids = new Set(members.flatMap((m) => m.spaces.map((s) => s.id)));
    expect([...ids]).toEqual([closedId]);
  });

  it("the role-change response carries the member's spaces", async () => {
    const res = await app.request(`/api/orgs/${owner.orgId}/members/${insider.user.id}`, {
      method: "PUT",
      headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgMember;
    // Promoted: the explicit row is dropped, every team space is reached by org role.
    expect(body.spaces.find((s) => s.id === privateId)?.source).toBe("org_role");
    expect(body.spaces.find((s) => s.id === closedId)?.source).toBe("org_role");
  });
});
