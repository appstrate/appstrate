// SPDX-License-Identifier: Apache-2.0

/**
 * Personal spaces over HTTP (RBAC spec §3.6).
 *
 * Three claims, and the suite is organised around them:
 *
 *   1. EVERY membership door provisions one, in its own transaction — a member
 *      without a personal space cannot exist, whichever door they came through.
 *   2. NOBODY else reaches it. The negative controls are the point: an
 *      organization owner and admin get 404 on the space, on a draft homed
 *      there, on the members list, on a space-scoped route, and on the SSE
 *      stream; an API key never reaches one at all; a role preview cannot even
 *      list one.
 *   3. It goes away through OFFBOARDING and nothing else: `PATCH`, an API-key
 *      mint and a member write are named 409s, the three administrative acts
 *      (`DELETE`, `convert-to-team`, `sweep-now`) answer 404 before 409 so that
 *      none of them confirms whose space an id is, `removeMember` stamps the
 *      window and names the space on its audit event, a re-invite inside it
 *      hands the space back, and the sweeper empties it — refusing while a run
 *      is still in flight.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  auditEvents,
  packages,
  runs,
  spaceMembers,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem, getDbRow } from "../../helpers/assertions.ts";
import {
  createTestContext,
  createTestUser,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedInstalledPackage,
  seedInvitation,
  seedPackage,
  seedRun,
  seedSpace,
  seedSpaceMember,
} from "../../helpers/seed.ts";
import { createBootstrapOrg } from "@appstrate/db/bootstrap-org";
import { resolveOrCreateOrgMembership } from "../../../src/modules/oidc/services/orgmember-mapping.ts";
import { removeMember } from "../../../src/services/organizations.ts";
import {
  convertPersonalSpaceToTeam,
  emptyAndDeletePersonalSpace,
  listSweepablePersonalSpaces,
  PERSONAL_SPACE_GRACE_DAYS,
} from "../../../src/services/spaces.ts";
import { sweepOrphanedPersonalSpaces } from "../../../src/services/personal-space-sweeper.ts";
import { applySpacePermissions } from "../../../src/middleware/space-context.ts";

const app = getTestApp();

interface ListedSpace {
  id: string;
  name: string;
  personal: boolean;
  visibility: string;
  access: "member" | "none";
  orphaned_at?: string | null;
}

/** `GET /api/spaces` — the route that also repairs the caller's own space. */
async function listSpaces(ctx: TestContext): Promise<ListedSpace[]> {
  const res = await app.request("/api/spaces", { headers: orgOnlyHeaders(ctx) });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { data: ListedSpace[] }).data;
}

/** The caller's own personal space, as their listing shows it. */
async function ownPersonalSpace(ctx: TestContext): Promise<ListedSpace> {
  const own = (await listSpaces(ctx)).filter((s) => s.personal);
  expect(own).toHaveLength(1);
  return own[0]!;
}

/** Straight from the table — for the doors, which do not go through a listing. */
async function personalSpaceRowsOf(orgId: string, userId: string) {
  return db
    .select()
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.ownerUserId, userId)));
}

describe("personal spaces — provisioning at every membership door", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("organization creation gives the owner a default space AND a personal one", async () => {
    const user = await createTestUser();
    const res = await app.request("/api/orgs", {
      method: "POST",
      headers: { Cookie: user.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fresh Org" }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const org = (await res.json()) as { id: string };

    const rows = await db.select().from(spaces).where(eq(spaces.orgId, org.id));
    const personal = rows.filter((s) => s.ownerUserId === user.id);
    expect(personal).toHaveLength(1);
    expect(personal[0]!.visibility).toBe("private");
    expect(personal[0]!.isDefault).toBe(false);
    // Constat 7: the default space is now inside the org transaction, not a
    // swallowed `.catch` after it.
    expect(rows.filter((s) => s.isDefault)).toHaveLength(1);
  });

  it("first-boot bootstrap does the same, from packages/db", async () => {
    const user = await createTestUser();
    const result = await createBootstrapOrg(user.id, "Bootstrapped");
    expect(result.created).toBe(true);
    const rows = await db.select().from(spaces).where(eq(spaces.orgId, result.orgId));
    expect(rows.filter((s) => s.isDefault)).toHaveLength(1);
    expect(rows.filter((s) => s.ownerUserId === user.id)).toHaveLength(1);
  });

  it("accepting an invitation provisions one for the invitee", async () => {
    const ctx = await createTestContext({ orgSlug: "invite-personal" });
    const invitee = await createTestUser();
    const inv = await seedInvitation({
      orgId: ctx.orgId,
      email: invitee.email,
      invitedBy: ctx.user.id,
      role: "member",
    });
    const res = await app.request(`/invite/${inv.token}/accept`, {
      method: "POST",
      headers: { Cookie: invitee.cookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await personalSpaceRowsOf(ctx.orgId, invitee.id)).toHaveLength(1);
  });

  it("SSO auto-provisioning provisions one for the arriving user", async () => {
    const ctx = await createTestContext({ orgSlug: "sso-personal" });
    const arriving = await createTestUser();
    const membership = await resolveOrCreateOrgMembership(
      { id: arriving.id, email: arriving.email, name: arriving.name },
      ctx.orgId,
      { allowSignup: true, signupRole: "member", signupSpaceAssignments: [] },
    );
    expect(membership.role).toBe("member");
    expect(await personalSpaceRowsOf(ctx.orgId, arriving.id)).toHaveLength(1);
  });

  it("GET /api/spaces repairs a missing one, and two concurrent reads make ONE row", async () => {
    const ctx = await createTestContext({ orgSlug: "lazy-personal" });
    // The fixture seeds membership straight into the table, so this org starts
    // in exactly the state `scripts/migration/0015` exists for: no personal
    // space anywhere.
    await db.delete(spaces).where(isNotNull(spaces.ownerUserId));
    expect(await personalSpaceRowsOf(ctx.orgId, ctx.user.id)).toHaveLength(0);

    const [a, b] = await Promise.all([listSpaces(ctx), listSpaces(ctx)]);
    expect(a.filter((s) => s.personal)).toHaveLength(1);
    expect(b.filter((s) => s.personal)).toHaveLength(1);
    expect(await personalSpaceRowsOf(ctx.orgId, ctx.user.id)).toHaveLength(1);
  });

  it("never provisions one for an API key or its creator behind their back", async () => {
    const ctx = await createTestContext({ orgSlug: "key-personal" });
    await db.delete(spaces).where(isNotNull(spaces.ownerUserId));
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["spaces:read"],
    });
    const res = await app.request("/api/spaces", {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ListedSpace[] };
    expect(body.data.map((s) => s.id)).toEqual([ctx.defaultSpaceId]);
    expect(await personalSpaceRowsOf(ctx.orgId, ctx.user.id)).toHaveLength(0);
  });
});

describe("personal spaces — nobody else reaches one", () => {
  let owner: TestContext;
  let admin: TestContext;
  let member: TestContext;
  let other: TestContext;
  /** `member`'s personal space. */
  let personalId: string;

  const SECRET = "@private/secret";

  const headersFor = (ctx: TestContext, spaceId: string) => ({
    Cookie: ctx.cookie,
    "X-Org-Id": ctx.orgId,
    "X-Space-Id": spaceId,
  });

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "private-org" });
    admin = await memberContext(owner, "admin");
    member = await memberContext(owner, "member");
    other = await memberContext(owner, "member");
    personalId = (await ownPersonalSpace(member)).id;

    // A skill authored in the personal space: homed there, installed there,
    // nowhere else. Exactly what "a private draft" means after lot 0.
    await seedPackage({
      id: SECRET,
      orgId: owner.orgId,
      type: "skill",
      homeSpaceId: personalId,
      draftManifest: { name: SECRET, version: "0.1.0", type: "skill" },
      draftContent: "---\nname: secret\ndescription: d\n---\n\nbody",
    });
    await seedInstalledPackage(personalId, SECRET);
  });

  it("lists it to its owner and to nobody else", async () => {
    const own = await ownPersonalSpace(member);
    expect(own.access).toBe("member");
    expect(own.visibility).toBe("private");
    for (const ctx of [owner, admin, other]) {
      expect((await listSpaces(ctx)).map((s) => s.id)).not.toContain(personalId);
    }
  });

  it("answers 404 on the space detail for the owner, the admin and another member", async () => {
    for (const ctx of [owner, admin, other]) {
      const res = await app.request(`/api/spaces/${personalId}`, { headers: orgOnlyHeaders(ctx) });
      await expectProblem(res, 404);
    }
    const mine = await app.request(`/api/spaces/${personalId}`, {
      headers: orgOnlyHeaders(member),
    });
    expect(mine.status).toBe(200);
  });

  it("answers 404 on every space-scoped route pointed at it", async () => {
    // One from each family the middleware covers: the space context itself is
    // what refuses, so this is the shape every route inherits.
    for (const path of ["/api/agents", "/api/runs", "/api/schedules", "/api/files"]) {
      await expectProblem(await app.request(path, { headers: headersFor(admin, personalId) }), 404);
      expect((await app.request(path, { headers: headersFor(member, personalId) })).status).toBe(
        200,
      );
    }
  });

  it("answers 404 on a draft homed there — from the personal space and from their own", async () => {
    const detail = `/api/packages/skills/${SECRET}`;
    await expectProblem(await app.request(detail, { headers: headersFor(admin, personalId) }), 404);
    // …and from a space the admin DOES reach: the home is not theirs, and the
    // org-catalogue exception covers a NULL home only.
    await expectProblem(
      await app.request(detail, { headers: headersFor(admin, owner.defaultSpaceId) }),
      404,
    );
    expect((await app.request(detail, { headers: headersFor(member, personalId) })).status).toBe(
      200,
    );
  });

  it("keeps it out of the admin's library listing, installed or not", async () => {
    const listed = async (ctx: TestContext) => {
      const res = await app.request("/api/library", {
        headers: headersFor(ctx, ctx === member ? personalId : owner.defaultSpaceId),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as {
        spaces: { id: string }[];
        packages: Record<string, { id: string }[]>;
      };
      return {
        packageIds: Object.values(body.packages).flatMap((rows) => rows.map((r) => r.id)),
        spaceIds: body.spaces.map((s) => s.id),
      };
    };

    const asAdmin = await listed(admin);
    expect(asAdmin.packageIds).not.toContain(SECRET);
    expect(asAdmin.spaceIds).not.toContain(personalId);
    expect((await listed(member)).packageIds).toContain(SECRET);

    // Uninstalled too: an admin's org-catalogue reach covers a NULL home only,
    // so a pure draft that lives in a personal space stays invisible.
    await db.delete(spacePackages).where(eq(spacePackages.packageId, SECRET));
    expect((await listed(admin)).packageIds).not.toContain(SECRET);
    expect((await listed(member)).packageIds).toContain(SECRET);
  });

  it("withholds the home's id from a colleague who reads the package through a team installation", async () => {
    // The leak this closes: once the author installs their draft into a team
    // space, everyone there can read the package — and the raw
    // `packages.home_space_id` would hand each of them the id of a space §3.6
    // says does not exist for them. `home_writable` carries the answer they
    // actually need.
    await seedInstalledPackage(owner.defaultSpaceId, SECRET);
    type HomeWire = { home_space_id: string | null; home_writable: boolean };
    const read = async (ctx: TestContext, spaceId: string): Promise<HomeWire> => {
      const res = await app.request(`/api/packages/skills/${SECRET}`, {
        headers: headersFor(ctx, spaceId),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as HomeWire;
      return { home_space_id: body.home_space_id, home_writable: body.home_writable };
    };

    expect(await read(admin, owner.defaultSpaceId)).toEqual({
      home_space_id: null,
      home_writable: false,
    });
    expect(await read(other, owner.defaultSpaceId)).toEqual({
      home_space_id: null,
      home_writable: false,
    });
    // Its author, reading from their own space: the id and the authority.
    expect(await read(member, personalId)).toEqual({
      home_space_id: personalId,
      home_writable: true,
    });

    // The same pair on the library listing, the other shape that carries it.
    const library = await app.request("/api/library", {
      headers: headersFor(admin, owner.defaultSpaceId),
    });
    const body = (await library.json()) as {
      packages: { skill: (HomeWire & { id: string })[] };
    };
    expect(body.packages.skill.find((p) => p.id === SECRET)).toMatchObject({
      home_space_id: null,
      home_writable: false,
    });
  });

  it("answers 404 on the members list, and lists only the owner to the owner", async () => {
    await expectProblem(
      await app.request(`/api/spaces/${personalId}/members`, { headers: orgOnlyHeaders(admin) }),
      404,
    );
    const mine = await app.request(`/api/spaces/${personalId}/members`, {
      headers: orgOnlyHeaders(member),
    });
    expect(mine.status, await mine.clone().text()).toBe(200);
    const body = (await mine.json()) as { data: { userId: string }[] };
    expect(body.data.map((row) => row.userId)).toEqual([member.user.id]);
  });

  it("refuses the SSE stream to an admin and opens it for the owner", async () => {
    const stream = (ctx: TestContext) =>
      app.request(`/api/realtime/runs?orgId=${ctx.orgId}&spaceId=${personalId}`, {
        headers: { Cookie: ctx.cookie, Accept: "text/event-stream" },
      });
    await expectProblem(await stream(admin), 404);
    const mine = await stream(member);
    expect(mine.status).toBe(200);
    await mine.body?.cancel();
  });

  it("closes the SSE stream on the PREVIEWER's own personal space", async () => {
    // The previewer's own space is the case the header cannot even name (the
    // 400 below covers `space=`): a persona holds no personal space, so
    // streaming the previewing admin's own through one would put a space in the
    // preview that the previewed role does not have.
    const ownPersonal = await ownPersonalSpace(owner);
    const url = `/api/realtime/runs?orgId=${owner.orgId}&spaceId=${ownPersonal.id}`;
    const mine = await app.request(url, {
      headers: { Cookie: owner.cookie, Accept: "text/event-stream" },
    });
    expect(mine.status).toBe(200);
    await mine.body?.cancel();

    // `?view_as=`, not the header: an `EventSource` cannot send one, and these
    // routes are exempt from the pipeline that reads it.
    await expectProblem(
      await app.request(`${url}&view_as=org_role%3Dmember`, {
        headers: { Cookie: owner.cookie, Accept: "text/event-stream" },
      }),
      404,
    );
  });

  it("is unreachable by an API key, whoever created it", async () => {
    // Pinned to the personal space by hand — the shape an operator could
    // otherwise mint. The key's creator IS the space's owner, and it still
    // reaches nothing: a key carries its creator's authority, not their privacy.
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: personalId,
      createdBy: member.user.id,
      scopes: ["agents:read", "spaces:read"],
    });
    await expectProblem(
      await app.request("/api/agents", { headers: { Authorization: `Bearer ${key.rawKey}` } }),
      404,
    );
    const listed = await app.request("/api/spaces", {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(((await listed.json()) as { data: ListedSpace[] }).data).toEqual([]);
  });

  it("cannot be previewed, and does not appear in a preview", async () => {
    const view = "org_role=member";
    await expectProblem(
      await app.request("/api/spaces", {
        headers: {
          ...orgOnlyHeaders(owner),
          "X-View-As": `${view};space=${personalId};role=preset:admin`,
        },
      }),
      400,
      { code: "invalid_view_as" },
    );
    // The previewer's OWN personal space is out of the preview too: a persona
    // has none, so listing one would show a space the previewed role lacks.
    const ownPersonal = await ownPersonalSpace(owner);
    const previewed = await app.request("/api/spaces", {
      headers: { ...orgOnlyHeaders(owner), "X-View-As": view },
    });
    expect(previewed.status).toBe(200);
    const body = (await previewed.json()) as { data: ListedSpace[] };
    expect(body.data.map((s) => s.id)).not.toContain(ownPersonal.id);
  });

  it("cannot be named by an invitation's space assignments", async () => {
    const res = await app.request(`/api/orgs/${owner.orgId}/members`, {
      method: "POST",
      headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "outsider@test.com",
        role: "guest",
        space_assignments: [{ space_id: personalId, preset_role: "operator" }],
      }),
    });
    await expectProblem(res, 400, { param: "space_assignments" });
  });

  it("cannot host a schedule for anyone but its owner", async () => {
    // The space context refuses before the schedule service is reached, which
    // is the whole mechanism: a schedule is created IN a space.
    await expectProblem(
      await app.request("/api/schedules", {
        method: "POST",
        headers: { ...headersFor(admin, personalId), "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: SECRET, cron: "0 * * * *" }),
      }),
      404,
    );
  });
});

describe("personal spaces — the write rules", () => {
  let owner: TestContext;
  let member: TestContext;
  let personalId: string;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "write-rules" });
    member = await memberContext(owner, "member");
    personalId = (await ownPersonalSpace(member)).id;
  });

  it("takes a rename and refuses visibility and default_role (409)", async () => {
    const patch = (body: unknown, ctx = member) =>
      app.request(`/api/spaces/${personalId}`, {
        method: "PATCH",
        headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const renamed = await patch({ name: "Mes brouillons" });
    expect(renamed.status, await renamed.clone().text()).toBe(200);

    await expectProblem(await patch({ visibility: "open" }), 409, {
      code: "personal_space_immutable",
    });
    await expectProblem(await patch({ default_role: "builder" }), 409, {
      code: "personal_space_immutable",
    });
    // Unchanged: the FIELD is refused, not a change of value.
    await expectProblem(await patch({ visibility: "private" }), 409, {
      code: "personal_space_immutable",
    });
  });

  it("refuses `owner_user_id` on creation — it is not a body field", async () => {
    const res = await app.request("/api/spaces", {
      method: "POST",
      headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sneaky", owner_user_id: member.user.id }),
    });
    await expectProblem(res, 400);
    const created = await app.request("/api/spaces", {
      method: "POST",
      headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ordinary" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()) as { personal: boolean }).toMatchObject({ personal: false });
  });

  it("refuses DELETE with 409, even to an org owner acting on their own", async () => {
    const ownPersonal = await ownPersonalSpace(owner);
    await expectProblem(
      await app.request(`/api/spaces/${ownPersonal.id}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(owner),
      }),
      409,
      { code: "personal_space_not_deletable" },
    );
    // The member's own is not even visible to them for deletion: `spaces:delete`
    // is org-level, so they never get as far as the 409.
    await expectProblem(
      await app.request(`/api/spaces/${personalId}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(member),
      }),
      403,
    );
  });

  it("refuses an API key with 409, and mints one in a team space", async () => {
    const create = (spaceId: string) =>
      app.request("/api/api-keys", {
        method: "POST",
        headers: {
          Cookie: member.cookie,
          "X-Org-Id": member.orgId,
          "X-Space-Id": spaceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "headless", scopes: ["agents:read"] }),
      });

    // A key carries no user, so `resolveSpaceRole` would answer `null` for it
    // here and every request it made would 404. Refused at the mint instead of
    // handed over dead.
    await expectProblem(await create(personalId), 409, {
      code: "personal_space_takes_no_keys",
    });

    // The positive control: the same caller, a team space they administer.
    const team = await seedSpace({ orgId: owner.orgId, name: "Keys" });
    await seedSpaceMember({ spaceId: team.id, userId: member.user.id, presetRole: "admin" });
    const minted = await create(team.id);
    expect(minted.status, await minted.clone().text()).toBe(201);
  });

  it("refuses an end-user with 409, and creates one in a team space", async () => {
    const create = (spaceId: string) =>
      app.request("/api/end-users", {
        method: "POST",
        headers: {
          Cookie: member.cookie,
          "X-Org-Id": member.orgId,
          "X-Space-Id": spaceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ externalId: `ext-${spaceId.slice(-6)}` }),
      });

    // Same reason as the API key and the OAuth client: an end-user is an
    // external identity somebody else signs in as, pointed at a space that
    // exists for exactly one member and goes away with them.
    await expectProblem(await create(personalId), 409, {
      code: "personal_space_takes_no_end_users",
    });

    // The positive control: the same caller, a team space they administer.
    const team = await seedSpace({ orgId: owner.orgId, name: "EndUsers" });
    await seedSpaceMember({ spaceId: team.id, userId: member.user.id, presetRole: "admin" });
    const created = await create(team.id);
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it("refuses a principal with no org role — the resolver is not the only gate", async () => {
    // An OIDC end-user token carries no org role, so it never reaches
    // `resolveSpaceRole`: `applySpacePermissions` returned early for it and the
    // token kept its strategy's fixed allowlist inside a personal space. The
    // refusal now sits on THIS side of that early return.
    //
    // Called directly rather than over HTTP: minting an end-user realm token
    // pinned to a personal space needs the oidc module's own harness (and the
    // route that would create such an end-user is the 409 above), so the seam
    // itself is what is asserted.
    const space = await getDbRow(spaces, eq(spaces.id, personalId));
    const values: Record<string, unknown> = { orgId: owner.orgId, user: member.user };
    const stub = {
      get: (key: string) => values[key],
      set: (key: string, value: unknown) => {
        values[key] = value;
      },
    } as unknown as Parameters<typeof applySpacePermissions>[0];

    await expect(applySpacePermissions(stub, space)).rejects.toThrow();
    expect(values.permissions).toBeUndefined();

    // The positive control, same stub: a TEAM space still returns silently for
    // an orgRole-less principal, whose permissions its strategy owns.
    const team = await seedSpace({ orgId: owner.orgId, name: "Realm" });
    await applySpacePermissions(stub, await getDbRow(spaces, eq(spaces.id, team.id)));
    expect(values.permissions).toBeUndefined();
  });

  it("refuses a space_members write with 409", async () => {
    const ownPersonal = await ownPersonalSpace(owner);
    await expectProblem(
      await app.request(`/api/spaces/${ownPersonal.id}/members`, {
        method: "POST",
        headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: member.user.id, preset_role: "viewer" }),
      }),
      409,
      { code: "personal_space_has_no_members" },
    );
  });
});

describe("personal spaces — convert to a team space", () => {
  let owner: TestContext;
  let member: TestContext;
  let personalId: string;

  const convert = (ctx: TestContext, spaceId: string) =>
    app.request(`/api/spaces/${spaceId}/convert-to-team`, {
      method: "POST",
      headers: orgOnlyHeaders(ctx),
    });

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "convert-org" });
    member = await memberContext(owner, "member");
    personalId = (await ownPersonalSpace(member)).id;
  });

  it("hands an ORPHANED space to the organization", async () => {
    // The case the 30-day window exists for: keep what the departing member
    // built, without ever letting an admin read it as-is.
    await removeMember(owner.orgId, member.user.id);
    const res = await convert(owner, personalId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()) as { personal: boolean; visibility: string }).toMatchObject({
      personal: false,
      // Nothing about the CONTENTS became less private.
      visibility: "private",
    });

    const row = await getDbRow(spaces, eq(spaces.id, personalId));
    expect(row.ownerUserId).toBeNull();
    expect(row.orphanedAt).toBeNull();

    // No `space_members` row: only an orphaned space converts, and its former
    // owner is by construction no longer a member of the organization.
    expect(
      await db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, personalId)),
    ).toHaveLength(0);

    // …and the space is now an ordinary team space: the admin reaches it.
    expect(
      (await app.request(`/api/spaces/${personalId}`, { headers: orgOnlyHeaders(owner) })).status,
    ).toBe(200);
    await getDbRow(
      auditEvents,
      and(
        eq(auditEvents.action, "space.converted_to_team"),
        eq(auditEvents.resourceId, personalId),
      )!,
    );
  });

  it("refuses a LIVE personal space — 404 to an admin, 409 to its own owner", async () => {
    // The heart of it: an active member's private workspace is not an
    // administrable object. An organization owner does not get a 409 either,
    // because a named refusal would confirm that this id IS somebody's personal
    // space — the one fact §3.6 withholds from them.
    await expectProblem(await convert(owner, personalId), 404);
    const row = await getDbRow(spaces, eq(spaces.id, personalId));
    expect(row.ownerUserId).toBe(member.user.id);

    // The caller's OWN live space: they can see it, so the reason is not a
    // disclosure and the refusal is named.
    const ownPersonal = await ownPersonalSpace(owner);
    await expectProblem(await convert(owner, ownPersonal.id), 409, {
      code: "personal_space_not_orphaned",
    });
  });

  it("refuses a team space (409) and refuses a member and an API key", async () => {
    await expectProblem(await convert(owner, owner.defaultSpaceId), 409, {
      code: "space_not_personal",
    });
    // A member holds no org-level `spaces:write`, not even over their own.
    await expectProblem(await convert(member, personalId), 403);
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: personalId,
      createdBy: owner.user.id,
      scopes: ["spaces:write"],
    });
    await expectProblem(
      await app.request(`/api/spaces/${personalId}/convert-to-team`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.rawKey}` },
      }),
      403,
    );
  });
});

/**
 * The three administrative acts a space id can be pointed at, against the three
 * kinds of caller that reach one — the matrix `assertSpaceAdminAct` exists for.
 *
 * The claim under test is that NONE of them is an existence oracle: a 409 that
 * names a live personal space belonging to somebody else would confirm what
 * every other route refuses to confirm, so it has to be a 404.
 */
describe("personal spaces — 404 before 409 on the three administrative acts", () => {
  let owner: TestContext;
  let admin: TestContext;
  let member: TestContext;
  /** `member`'s personal space — live at the start of every case. */
  let personalId: string;

  const ACTS = {
    delete: (ctx: TestContext, spaceId: string) =>
      app.request(`/api/spaces/${spaceId}`, { method: "DELETE", headers: orgOnlyHeaders(ctx) }),
    "convert-to-team": (ctx: TestContext, spaceId: string) =>
      app.request(`/api/spaces/${spaceId}/convert-to-team`, {
        method: "POST",
        headers: orgOnlyHeaders(ctx),
      }),
    sweep: (ctx: TestContext, spaceId: string) =>
      app.request(`/api/spaces/${spaceId}/sweep-now`, {
        method: "POST",
        headers: orgOnlyHeaders(ctx),
      }),
  } as const;
  const ACT_NAMES = Object.keys(ACTS) as (keyof typeof ACTS)[];

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "acts-org" });
    admin = await memberContext(owner, "admin");
    member = await memberContext(owner, "member");
    personalId = (await ownPersonalSpace(member)).id;
  });

  it("answers 404 on a LIVE personal space that is not the caller's, for all three", async () => {
    for (const act of ACT_NAMES) {
      for (const ctx of [owner, admin]) {
        await expectProblem(await ACTS[act](ctx, personalId), 404);
      }
    }
    // Nothing happened to it.
    expect((await getDbRow(spaces, eq(spaces.id, personalId))).ownerUserId).toBe(member.user.id);
  });

  it("answers a NAMED 409 on the caller's own live personal space, for all three", async () => {
    const own = await ownPersonalSpace(owner);
    const expected = {
      delete: "personal_space_not_deletable",
      "convert-to-team": "personal_space_not_orphaned",
      sweep: "personal_space_not_orphaned",
    } as const;
    for (const act of ACT_NAMES) {
      await expectProblem(await ACTS[act](owner, own.id), 409, { code: expected[act] });
    }
    await getDbRow(spaces, eq(spaces.id, own.id));
  });

  it("answers 404 to an API KEY on its own creator's personal space", async () => {
    // The named 409 is reserved for a caller who can SEE the space, and a key
    // cannot: it carries its creator's authority, not their privacy, so
    // `callerPersonalOwnerId` is `null` for it and every other route 404s here.
    // Reading the creator's id instead made `DELETE` the one route that
    // confirmed the id was their personal space.
    const own = await ownPersonalSpace(owner);
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: own.id,
      createdBy: owner.user.id,
      scopes: ["spaces:delete"],
    });
    await expectProblem(
      await app.request(`/api/spaces/${own.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key.rawKey}` },
      }),
      404,
    );
    await getDbRow(spaces, eq(spaces.id, own.id));
  });

  it("lets an owner or admin act on an ORPHANED one, delete excepted", async () => {
    await removeMember(owner.orgId, member.user.id);

    // `DELETE` never applies to a personal space: `sweep-now` is the route that
    // empties it first, and a named 409 here is safe because an orphan is
    // already listed to owners and admins.
    await expectProblem(await ACTS.delete(admin, personalId), 409, {
      code: "personal_space_not_deletable",
    });

    expect((await ACTS["convert-to-team"](admin, personalId)).status).toBe(200);
    expect((await getDbRow(spaces, eq(spaces.id, personalId))).ownerUserId).toBeNull();
  });

  it("sweeps an orphaned one for an owner, and refuses a team space by name", async () => {
    await removeMember(owner.orgId, member.user.id);
    for (const act of ["convert-to-team", "sweep"] as const) {
      await expectProblem(await ACTS[act](owner, owner.defaultSpaceId), 409, {
        code: "space_not_personal",
      });
    }
    const res = await ACTS.sweep(owner, personalId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await db.select().from(spaces).where(eq(spaces.id, personalId))).toHaveLength(0);
  });
});

describe("personal spaces — offboarding", () => {
  let owner: TestContext;
  let member: TestContext;
  let personalId: string;

  const HOMED = "@leaving/only-here";
  const SHARED = "@leaving/also-elsewhere";

  /** Push the orphan stamp past the grace window, without waiting 30 days. */
  async function ageOrphan(spaceId: string) {
    const past = new Date(Date.now() - (PERSONAL_SPACE_GRACE_DAYS + 1) * 86_400_000);
    await db.update(spaces).set({ orphanedAt: past }).where(eq(spaces.id, spaceId));
  }

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "offboard-org" });
    member = await memberContext(owner, "member");
    personalId = (await ownPersonalSpace(member)).id;
  });

  it("stamps the window on removal instead of deleting anything", async () => {
    await removeMember(owner.orgId, member.user.id);
    const row = await getDbRow(spaces, eq(spaces.id, personalId));
    expect(row.orphanedAt).not.toBeNull();
    expect(row.ownerUserId).toBe(member.user.id);
  });

  it("lists an orphaned space to owners and admins, with `orphaned_at`, unenterable", async () => {
    await removeMember(owner.orgId, member.user.id);
    const listed = (await listSpaces(owner)).find((s) => s.id === personalId);
    expect(listed).toBeDefined();
    expect(listed!.personal).toBe(true);
    expect(listed!.access).toBe("none");
    expect(listed!.orphaned_at).toBeTruthy();

    // A plain member still sees nothing: only the two administrative acts
    // justify listing it at all.
    const otherMember = await memberContext(owner, "member");
    expect((await listSpaces(otherMember)).map((s) => s.id)).not.toContain(personalId);
  });

  it("hands the space back untouched when the member re-joins inside the window", async () => {
    await removeMember(owner.orgId, member.user.id);
    const inv = await seedInvitation({
      orgId: owner.orgId,
      email: member.user.email,
      invitedBy: owner.user.id,
      role: "member",
    });
    const res = await app.request(`/invite/${inv.token}/accept`, {
      method: "POST",
      headers: { Cookie: member.cookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const row = await getDbRow(spaces, eq(spaces.id, personalId));
    expect(row.orphanedAt).toBeNull();
    // The SAME space: a second one would have been refused by the unique index,
    // and a new one would have lost the drafts.
    expect(await personalSpaceRowsOf(owner.orgId, member.user.id)).toHaveLength(1);
  });

  it("sweeps a space past the window: home cleared, private package deleted, space gone", async () => {
    const otherSpace = await seedSpace({ orgId: owner.orgId, name: "Team" });
    for (const id of [HOMED, SHARED]) {
      await seedPackage({
        id,
        orgId: owner.orgId,
        type: "skill",
        homeSpaceId: personalId,
        draftManifest: { name: id, version: "0.1.0", type: "skill" },
        draftContent: `---\nname: x\ndescription: d\n---\n\n${id}`,
      });
      await seedInstalledPackage(personalId, id);
    }
    // Only one of the two is installed somewhere else.
    await seedInstalledPackage(otherSpace.id, SHARED);

    await removeMember(owner.orgId, member.user.id);
    await ageOrphan(personalId);

    const result = await sweepOrphanedPersonalSpaces();
    expect(result).toEqual({ sweptSpaces: 1, failedSpaces: 0 });

    // Installed elsewhere → the organization catalogue, not deleted: somebody
    // is running it, so it was never private.
    expect((await getDbRow(packages, eq(packages.id, SHARED))).homeSpaceId).toBeNull();
    // Lived only there → deleted with the person who wrote it.
    expect(await db.select().from(packages).where(eq(packages.id, HOMED))).toHaveLength(0);
    expect(await db.select().from(spaces).where(eq(spaces.id, personalId))).toHaveLength(0);
  });

  it("leaves a space inside the window alone", async () => {
    await removeMember(owner.orgId, member.user.id);
    expect(await sweepOrphanedPersonalSpaces()).toEqual({ sweptSpaces: 0, failedSpaces: 0 });
    await getDbRow(spaces, eq(spaces.id, personalId));
  });

  it("sweep-now runs it immediately, without waiting out the window", async () => {
    // What sweep-now REFUSES is the matrix of the "404 before 409" suite; here
    // the claim is only that an administrator does not have to wait 30 days.
    const sweepNow = (ctx: TestContext, spaceId: string) =>
      app.request(`/api/spaces/${spaceId}/sweep-now`, {
        method: "POST",
        headers: orgOnlyHeaders(ctx),
      });

    await removeMember(owner.orgId, member.user.id);
    // No ageing: an administrator does not have to wait out the window.
    const res = await sweepNow(owner, personalId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({
      object: "space_sweep",
      space_id: personalId,
      rehomed_packages: 0,
      deleted_packages: 0,
    });
    expect(await db.select().from(spaces).where(eq(spaces.id, personalId))).toHaveLength(0);
    await getDbRow(
      auditEvents,
      and(eq(auditEvents.action, "space.swept"), eq(auditEvents.resourceId, personalId))!,
    );
  });

  it("refuses on a run in flight WITHOUT having touched the packages it homes", async () => {
    // The routine is ONE transaction, and the refusals come before the first
    // package mutation. Both halves of that matter here: the run makes the
    // space deletion refuse, and the package this space HOMES — the one the
    // routine would have deleted, since it lives nowhere else — has to still be
    // there afterwards, homed where it was. Emptying the packages in a
    // transaction of their own left them destroyed and the space standing,
    // which is the loss the 30-day window exists to prevent.
    const pkg = await seedPackage({
      id: HOMED,
      orgId: owner.orgId,
      type: "agent",
      homeSpaceId: personalId,
      draftManifest: { name: HOMED, version: "0.1.0", type: "agent" },
    });
    const run = await seedRun({
      orgId: owner.orgId,
      spaceId: personalId,
      packageId: pkg.id,
      status: "running",
    });
    await removeMember(owner.orgId, member.user.id);
    await ageOrphan(personalId);

    expect(await sweepOrphanedPersonalSpaces()).toEqual({ sweptSpaces: 0, failedSpaces: 1 });
    const survivor = await getDbRow(spaces, eq(spaces.id, personalId));
    expect(survivor.orphanedAt).not.toBeNull();
    expect((await getDbRow(packages, eq(packages.id, HOMED))).homeSpaceId).toBe(personalId);

    // Once the run settles, the next pass does the whole thing.
    await db.update(runs).set({ status: "success" }).where(eq(runs.id, run.id));
    expect(await sweepOrphanedPersonalSpaces()).toEqual({ sweptSpaces: 1, failedSpaces: 0 });
    expect(await db.select().from(packages).where(eq(packages.id, HOMED))).toHaveLength(0);
    expect(await db.select().from(spaces).where(eq(spaces.id, personalId))).toHaveLength(0);
  });

  it("refuses when the space was converted to a team space after the listing", async () => {
    // The sweeper picks its spaces in one read and acts in another, so an
    // administrator can convert one in between — which is exactly what the
    // window is for. Re-asserting "personal AND orphaned" under the row lock is
    // what stops the sweep from deleting a TEAM space and everything the
    // conversion was meant to keep.
    await seedPackage({
      id: HOMED,
      orgId: owner.orgId,
      type: "skill",
      homeSpaceId: personalId,
      draftManifest: { name: HOMED, version: "0.1.0", type: "skill" },
      draftContent: "---\nname: x\ndescription: d\n---\n\nbody",
    });
    await removeMember(owner.orgId, member.user.id);
    await ageOrphan(personalId);
    expect((await listSweepablePersonalSpaces()).map((s) => s.id)).toContain(personalId);

    await convertPersonalSpaceToTeam(owner.orgId, personalId);

    await expect(emptyAndDeletePersonalSpace(owner.orgId, personalId)).rejects.toMatchObject({
      status: 409,
      code: "space_not_personal",
    });
    await getDbRow(spaces, eq(spaces.id, personalId));
    expect((await getDbRow(packages, eq(packages.id, HOMED))).homeSpaceId).toBe(personalId);
  });

  it("refuses to delete a space with a run in progress, and sweeps it once it settles", async () => {
    // The space delete cascade-drops `runs`, so performing it under a live
    // container rips the rows out from under it — the same rule organization
    // deletion has, from the same predicate. The sweeper counts a failure and
    // retries next pass.
    // Homed in a TEAM space, so the only thing holding the delete back is the
    // run itself.
    const pkg = await seedPackage({
      id: "@offboard/runner",
      orgId: owner.orgId,
      type: "agent",
      homeSpaceId: owner.defaultSpaceId,
      draftManifest: { name: "@offboard/runner", version: "0.1.0", type: "agent" },
    });
    const run = await seedRun({
      orgId: owner.orgId,
      spaceId: personalId,
      packageId: pkg.id,
      status: "running",
    });
    await removeMember(owner.orgId, member.user.id);
    await ageOrphan(personalId);

    expect(await sweepOrphanedPersonalSpaces()).toEqual({ sweptSpaces: 0, failedSpaces: 1 });
    await getDbRow(spaces, eq(spaces.id, personalId));

    await db.update(runs).set({ status: "success" }).where(eq(runs.id, run.id));
    expect(await sweepOrphanedPersonalSpaces()).toEqual({ sweptSpaces: 1, failedSpaces: 0 });
    expect(await db.select().from(spaces).where(eq(spaces.id, personalId))).toHaveLength(0);
  });

  it("records the orphaned space ids on the member-removal audit event", async () => {
    // The sweeper's own log line arrives 30 days later, by which time the space
    // is gone: this event is what an owner comes back to when deciding whether
    // to convert one.
    const res = await app.request(`/api/orgs/${owner.orgId}/members/${member.user.id}`, {
      method: "DELETE",
      headers: orgOnlyHeaders(owner),
    });
    expect(res.status, await res.clone().text()).toBe(204);
    const event = await getDbRow(
      auditEvents,
      and(
        eq(auditEvents.action, "org.member_removed"),
        eq(auditEvents.resourceId, member.user.id),
      )!,
    );
    expect(event.after).toEqual({ orphanedSpaceIds: [personalId] });
  });
});
