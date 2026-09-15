// SPDX-License-Identifier: Apache-2.0

/**
 * The library, in its two shapes — a map of PLACEMENTS (RBAC spec §6.8).
 *
 * One row per package, one `placements` entry per space the package is placed
 * in and the caller reads, saying WHY it is there (`via`) and whether that
 * space runs it (`state`). There is no `shared` section in either shape: a
 * pending offer is a placement with `state: "none"`, on the package's own row
 * and behind the same switch as every other space.
 *
 * The fixture is the shape the three axes are hardest to tell apart in: one
 * agent homed in Alpha, offered to Beta and taken up there, offered to Gamma
 * and NOT taken up, switched off again in Delta, plus a system skill nobody
 * placed anywhere.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { organizationMembers, packages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedApiKey,
  seedPackage,
  seedPackageShare,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
} from "../../helpers/seed.ts";

const app = getTestApp();

const AGENT = "@lib/worker";
/** A package the organization owns and no space homes — the org catalogue. */
const CATALOGUE = "@lib/catalogue";
const SYSTEM_SKILL = "@appstrate/system-skill";

interface Placement {
  space_id: string;
  via: "home" | "shared" | "system";
  state: "active" | "inactive" | "none";
  shared_by: { user_id: string; name: string } | null;
}

interface LibraryRow {
  id: string;
  home_space_id: string | null;
  home_writable: boolean;
  home_shareable: boolean;
  placements: Placement[];
}

interface LibraryBody {
  object: string;
  spaces: { id: string; name: string; isDefault: boolean }[];
  packages: Record<string, LibraryRow[]>;
}

let ctx: TestContext;
let alphaId: string;
let betaId: string;
let gammaId: string;
let deltaId: string;

const owner = (spaceId: string) => ({
  Cookie: ctx.cookie,
  "X-Org-Id": ctx.orgId,
  "X-Space-Id": spaceId,
});

async function orgLibrary(headers: Record<string, string>): Promise<LibraryBody> {
  const res = await app.request("/api/library", { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as LibraryBody;
}

async function spaceLibrary(
  headers: Record<string, string>,
  spaceId: string,
): Promise<LibraryBody> {
  const res = await app.request(`/api/spaces/${spaceId}/library`, { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as LibraryBody;
}

const rowOf = (body: LibraryBody, type: string, id: string) =>
  body.packages[type]?.find((entry) => entry.id === id);

const placementOf = (row: LibraryRow | undefined, spaceId: string) =>
  row?.placements.find((p) => p.space_id === spaceId);

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "liborg" });
  alphaId = ctx.defaultSpaceId;
  betaId = (await seedSpace({ orgId: ctx.orgId, name: "Beta" })).id;
  gammaId = (await seedSpace({ orgId: ctx.orgId, name: "Gamma" })).id;
  deltaId = (await seedSpace({ orgId: ctx.orgId, name: "Delta" })).id;

  await seedAgent({
    id: AGENT,
    orgId: ctx.orgId,
    createdBy: ctx.user.id,
    homeSpaceId: alphaId,
    draftManifest: { name: AGENT, version: "0.1.0", type: "agent", display_name: "Worker" },
  });
  // Home: active where it lives.
  await seedSpacePackage(alphaId, AGENT);
  // Offered to Beta and taken up.
  await seedPackageShare(betaId, AGENT, ctx.user.id);
  await seedSpacePackage(betaId, AGENT);
  // Offered to Gamma and NOT taken up — the pending offer.
  await seedPackageShare(gammaId, AGENT, ctx.user.id);
  // Offered to Delta, taken up, then switched off.
  await seedPackageShare(deltaId, AGENT, null);
  await seedSpacePackage(deltaId, AGENT, { enabled: false });
});

describe("GET /api/library — the organization map", () => {
  it("renders every placement with its reason and its state, and one row per package", async () => {
    const body = await orgLibrary(owner(alphaId));
    const rows = body.packages.agent?.filter((entry) => entry.id === AGENT) ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(placementOf(row, alphaId)).toEqual({
      space_id: alphaId,
      via: "home",
      state: "active",
      // A home places the package by owning it — nobody offered it.
      shared_by: null,
    });
    expect(placementOf(row, betaId)).toMatchObject({ via: "shared", state: "active" });
    expect(placementOf(row, betaId)?.shared_by?.user_id).toBe(ctx.user.id);
    // The pending offer: placed, and nothing has switched it on.
    expect(placementOf(row, gammaId)).toMatchObject({ via: "shared", state: "none" });
    // Taken up and put back down — the row and its settings survive, which is
    // exactly what `inactive` reports and `none` does not.
    expect(placementOf(row, deltaId)).toMatchObject({ via: "shared", state: "inactive" });
    // A share written by a home MOVE names no author.
    expect(placementOf(row, deltaId)?.shared_by).toBeNull();

    expect(row.home_space_id).toBe(alphaId);
    expect(row.home_writable).toBe(true);
    expect(row.home_shareable).toBe(true);
  });

  it("carries no `shared` section — the offer is on the row", async () => {
    const res = await app.request("/api/library", { headers: owner(alphaId) });
    expect(Object.keys((await res.json()) as object).sort()).toEqual([
      "object",
      "packages",
      "spaces",
    ]);
  });

  it("lists an organization-catalogue package placed nowhere, for an administrator", async () => {
    await seedPackage({
      id: CATALOGUE,
      orgId: ctx.orgId,
      type: "skill",
      homeSpaceId: null,
      draftManifest: { name: CATALOGUE, version: "0.1.0", type: "skill" },
    });
    const row = rowOf(await orgLibrary(owner(alphaId)), "skill", CATALOGUE);
    expect(row).toBeDefined();
    // Nowhere placed, so nothing to say about any space: an EMPTY array, not a
    // row that disappears. `home_space_id: null` IS the organization catalogue.
    expect(row!.placements).toEqual([]);
    expect(row!.home_space_id).toBeNull();
  });

  it("is refused to a member, a guest and an API key", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    await expectProblem(
      await app.request("/api/library", {
        headers: { Cookie: member.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": alphaId },
      }),
      403,
    );

    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: alphaId,
      createdBy: ctx.user.id,
      scopes: ["spaces:read", "agents:read", "skills:read"],
    });
    await expectProblem(
      await app.request("/api/library", {
        headers: { Authorization: `Bearer ${key.rawKey}` },
      }),
      403,
    );
  });
});

describe("GET /api/spaces/{id}/library — one space's page", () => {
  it("narrows the placements to the requested space", async () => {
    const row = rowOf(await spaceLibrary(owner(betaId), betaId), "agent", AGENT);
    expect(row?.placements.map((p) => p.space_id)).toEqual([betaId]);
    expect(placementOf(row, betaId)).toMatchObject({ via: "shared", state: "active" });
  });

  it("shows a pending offer as a placement of the row, with its sharer", async () => {
    const row = rowOf(await spaceLibrary(owner(gammaId), gammaId), "agent", AGENT);
    expect(row?.placements).toHaveLength(1);
    expect(placementOf(row, gammaId)).toMatchObject({ via: "shared", state: "none" });
    expect(placementOf(row, gammaId)?.shared_by?.user_id).toBe(ctx.user.id);
  });

  it("stops naming a sharer who has LEFT the organization", async () => {
    // `package_shares.shared_by` is `ON DELETE SET NULL` on `user`, so deleting
    // the ACCOUNT clears it — but leaving the ORG clears nothing, and this map
    // is served to every owner and admin, on every row. The membership is part
    // of the join, so the name never leaves the database rather than being
    // filtered out afterwards.
    const outsider = await createTestUser();
    await addOrgMember(ctx.orgId, outsider.id, "member");
    const shared = "@lib/from-a-leaver";
    await seedAgent({ id: shared, orgId: ctx.orgId, homeSpaceId: alphaId });
    await seedPackageShare(gammaId, shared, outsider.id);

    const named = rowOf(await spaceLibrary(owner(gammaId), gammaId), "agent", shared);
    expect(placementOf(named, gammaId)?.shared_by?.user_id).toBe(outsider.id);

    await db
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, outsider.id)),
      );

    const anonymous = rowOf(await spaceLibrary(owner(gammaId), gammaId), "agent", shared);
    // The offer still stands — only the name behind it is withheld.
    expect(placementOf(anonymous, gammaId)).toMatchObject({ via: "shared", state: "none" });
    expect(placementOf(anonymous, gammaId)?.shared_by).toBeNull();
  });

  it("offers a package the caller could still PLACE here, with an empty placements array", async () => {
    // The candidate rule: a package whose home grants the caller `<type>:share`
    // is listed for a TEAM destination, because `POST /api/spaces/{id}/packages`
    // would create the offer along with the activation. Nothing places it here
    // yet, so it has no placement to report.
    const fresh = (await seedSpace({ orgId: ctx.orgId, name: "Fresh" })).id;
    const row = rowOf(await spaceLibrary(owner(fresh), fresh), "agent", AGENT);
    expect(row).toBeDefined();
    expect(row!.placements).toEqual([]);
    expect(row!.home_shareable).toBe(true);
  });

  it("proposes nothing extra to a PERSONAL destination — an offer is somebody else's act", async () => {
    // The negative control on the candidate rule above: the same package, the
    // same caller, a personal space. Nobody offers a package into their own
    // space on their own behalf, so it is not listed there at all.
    // `GET /api/spaces` says `personal: true` and never whose (§3.6), and the
    // listing only ever carries the caller's OWN — which is what makes the
    // flag enough to find it. The lazy repair provisions it on that same call.
    const listed = await app.request("/api/spaces", { headers: owner(alphaId) });
    expect(listed.status, await listed.clone().text()).toBe(200);
    const mine = ((await listed.json()) as { data: { id: string; personal: boolean }[] }).data;
    const own = mine.find((space) => space.personal);
    expect(own).toBeDefined();
    const row = rowOf(await spaceLibrary(owner(own!.id), own!.id), "agent", AGENT);
    expect(row).toBeUndefined();
  });

  it("withholds a placement in a space the caller cannot read", async () => {
    // A builder of Beta alone must learn nothing about Alpha, Gamma or Delta
    // from this page — the placements are the caller's own reach, not the
    // package's.
    const user = await createTestUser();
    await addOrgMember(ctx.orgId, user.id, "guest");
    await seedSpaceMember({ spaceId: betaId, userId: user.id, presetRole: "builder" });
    const headers = { Cookie: user.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": betaId };
    const row = rowOf(await spaceLibrary(headers, betaId), "agent", AGENT);
    expect(row?.placements.map((p) => p.space_id)).toEqual([betaId]);
    // …and the home is withheld with it: the id would name a space they cannot
    // enter.
    expect(row?.home_space_id).toBeNull();
    expect(row?.home_writable).toBe(false);
  });

  it("answers an API key within its pinned space only", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: betaId,
      createdBy: ctx.user.id,
      scopes: ["spaces:read", "agents:read", "skills:read"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}` };
    const body = await spaceLibrary(headers, betaId);
    expect(body.spaces.map((space) => space.id)).toEqual([betaId]);
    expect(rowOf(body, "agent", AGENT)?.placements.map((p) => p.space_id)).toEqual([betaId]);
    // And it never leaves that space: the pin is enforced before the library is
    // even read, so a key never sees a sibling space's placements.
    const fresh = (await seedSpace({ orgId: ctx.orgId, name: "Unpinned" })).id;
    await expectProblem(await app.request(`/api/spaces/${fresh}/library`, { headers }), 403);
  });
});

describe("system packages", () => {
  beforeEach(async () => {
    await seedPackage({
      id: SYSTEM_SKILL,
      orgId: null,
      type: "skill",
      source: "system",
      draftManifest: { name: SYSTEM_SKILL, version: "1.0.0", type: "skill" },
    });
  });

  it("place themselves in every readable space, and are active there", async () => {
    const row = rowOf(await orgLibrary(owner(alphaId)), "skill", SYSTEM_SKILL);
    expect(row).toBeDefined();
    const spaces = row!.placements.map((p) => p.space_id).sort();
    expect(spaces).toEqual([alphaId, betaId, gammaId, deltaId].sort());
    for (const placement of row!.placements) {
      expect(placement).toMatchObject({ via: "system", state: "active", shared_by: null });
    }
  });

  it("read `inactive` where a placement row says so — the row outranks the default", async () => {
    // The ROW always wins, a system package included: the deployment's default
    // only decides where the space has stated nothing. Rendering `active` over
    // an explicit `false` would be a switch that changes nothing — and the run
    // gate reads the same rule, so the space really does stop running it.
    await seedSpacePackage(alphaId, SYSTEM_SKILL, { enabled: false });
    const row = rowOf(await orgLibrary(owner(alphaId)), "skill", SYSTEM_SKILL);
    expect(placementOf(row, alphaId)).toMatchObject({ via: "system", state: "inactive" });
    // Only here: the other spaces never answered, so they keep the default.
    expect(placementOf(row, betaId)).toMatchObject({ via: "system", state: "active" });
  });
});

describe("integrations take their state from the activation resolver", () => {
  const INTEGRATION = "@lib/gmail";

  beforeEach(async () => {
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId: alphaId,
      draftManifest: { name: INTEGRATION, version: "0.1.0", type: "integration" },
    });
  });

  it("reads `none` with no row, `active` when enabled and `inactive` when switched off", async () => {
    // Reading `space_packages` directly would have been enough for the first
    // two and wrong for a system integration, which is active with no row at
    // all — hence the resolver, and hence this trio as its pin.
    const stateIn = async (spaceId: string) =>
      placementOf(rowOf(await orgLibrary(owner(alphaId)), "integration", INTEGRATION), spaceId)
        ?.state;

    expect(await stateIn(alphaId)).toBe("none");
    await seedSpacePackage(alphaId, INTEGRATION);
    expect(await stateIn(alphaId)).toBe("active");
    await seedSpacePackage(alphaId, INTEGRATION, { enabled: false });
    expect(await stateIn(alphaId)).toBe("inactive");
  });

  it("never PROPOSES a deployment integration in a personal space — but never hides a real row either", async () => {
    // Two halves of one rule, and the bug was that the first swallowed the
    // second. The deployment's own integrations are not proposed in somebody's
    // private workspace: they would run on that person's credentials, and
    // nobody puts an integration there on their behalf. But once the space
    // HOLDS a `space_packages` row, that row is a decision its owner made, and
    // a map that omits it is a map lying about a state the platform persisted —
    // with no way back to the switch that set it.
    const SYSTEM_INTEGRATION = "@appstrate/system-gmail";
    await seedPackage({
      id: SYSTEM_INTEGRATION,
      orgId: null,
      source: "system",
      type: "integration",
      homeSpaceId: null,
      draftManifest: { name: SYSTEM_INTEGRATION, version: "1.0.0", type: "integration" },
    });

    const listed = await app.request("/api/spaces", { headers: owner(alphaId) });
    const mine = ((await listed.json()) as { data: { id: string; personal: boolean }[] }).data;
    const personalId = mine.find((space) => space.personal)!.id;

    const placementIn = async () =>
      placementOf(
        rowOf(await spaceLibrary(owner(personalId), personalId), "integration", SYSTEM_INTEGRATION),
        personalId,
      );

    // No row: not proposed, so not on the map at all.
    expect(await placementIn()).toBeUndefined();

    // A row — here the sticky opt-out its owner set — IS on the map.
    await seedSpacePackage(personalId, SYSTEM_INTEGRATION, { enabled: false });
    expect(await placementIn()).toMatchObject({ via: "system", state: "inactive" });

    // …and so is the other decision, for the same reason.
    await seedSpacePackage(personalId, SYSTEM_INTEGRATION, { enabled: true });
    expect(await placementIn()).toMatchObject({ via: "system", state: "active" });
  });
});

describe("the home trio travels with every row", () => {
  it("answers `home_writable` and `home_shareable` per caller", async () => {
    const viewer = await createTestUser();
    await addOrgMember(ctx.orgId, viewer.id, "guest");
    await seedSpaceMember({ spaceId: alphaId, userId: viewer.id, presetRole: "viewer" });
    const headers = { Cookie: viewer.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": alphaId };

    const row = rowOf(await spaceLibrary(headers, alphaId), "agent", AGENT);
    expect(row?.home_space_id).toBe(alphaId);
    // A viewer reads the home and governs nothing in it — the pair is not one
    // boolean under two names.
    expect(row?.home_writable).toBe(false);
    expect(row?.home_shareable).toBe(false);
    // The package still IS placed here, and the page says so.
    expect(placementOf(row, alphaId)).toMatchObject({ via: "home", state: "active" });
  });

  it("does not disclose a home the caller cannot reach", async () => {
    await db.update(packages).set({ homeSpaceId: gammaId }).where(eq(packages.id, AGENT));
    const user = await createTestUser();
    await addOrgMember(ctx.orgId, user.id, "guest");
    await seedSpaceMember({ spaceId: betaId, userId: user.id, presetRole: "builder" });
    const headers = { Cookie: user.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": betaId };
    expect(rowOf(await spaceLibrary(headers, betaId), "agent", AGENT)?.home_space_id).toBeNull();
  });
});
