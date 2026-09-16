// SPDX-License-Identifier: Apache-2.0

/**
 * The write-authority rule, called directly.
 *
 * `assertPackageMutationAccess` reads ONE thing to decide who may change a
 * package: `packages.home_space_id` (RBAC spec §6.9). The route suites exercise
 * it through HTTP, where a refusal can also come from the route's own guard;
 * here the function is called with a stub context and an explicit space list,
 * so each assertion pins the rule itself and nothing above it.
 *
 * `resolvedSpaces` is passed on every call, which is what keeps the context a
 * stub: `packageAccessSpaces` is the only reader of the rest of a real one.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { ApiError } from "@appstrate/core/api-errors";
import { packages, spacePackages } from "@appstrate/db/schema";
import {
  assertCatalogPackageAccess,
  assertPackageMutationAccess,
  assertPackageShareAccess,
  packageAccessSpaces,
  placementGrantsRead,
} from "../../../src/lib/package-access.ts";
import type { Permission } from "../../../src/lib/permissions.ts";
import type { AppEnv } from "../../../src/types/index.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedSpacePackage, seedPackage, seedPackageShare, seedSpace } from "../../helpers/seed.ts";
import { packageShares } from "@appstrate/db/schema";
import { listOrgItems } from "../../../src/services/package-items/crud.ts";
import { CONFIG_BY_TYPE } from "../../../src/services/package-items/config.ts";
import { placementReadFilter } from "../../../src/services/package-placement.ts";

type AccessibleSpaces = Awaited<ReturnType<typeof packageAccessSpaces>>;

const SKILL = "@home/secret";

let ctx: TestContext;
/** Where the package lives. */
let homeId: string;
/** Another space it is installed in — a consumer, never an authority. */
let otherId: string;

/** A space entry as `packageAccessSpaces` returns it, with the permissions given. */
function space(id: string, permissions: string[]) {
  return {
    id,
    name: id,
    isDefault: false,
    visibility: "closed" as const,
    defaultRole: "viewer" as const,
    ownerUserId: null,
    permissions: new Set(permissions as Permission[]),
  };
}

/**
 * The caller. `permissions` is the coarse guard the route pipeline would have
 * set for the current space; `orgRole` and `authMethod` shape the reach
 * `packageAccessSpaces` would have resolved, which is what the home rule reads.
 */
function caller(
  opts: {
    orgRole: "owner" | "admin" | "member" | "guest";
    permissions: string[];
    authMethod?: string;
  },
  /**
   * The caller's reach, seeded into the per-request memo `packageAccessSpaces`
   * reads. It used to travel as an explicit argument through every assert;
   * seeding the memo is how a REQUEST states it now, so the fixture and the
   * production path agree on where that set comes from.
   */
  accessible?: AccessibleSpaces,
): Context<AppEnv> {
  const values: Record<string, unknown> = {
    orgId: ctx.orgId,
    orgRole: opts.orgRole,
    authMethod: opts.authMethod ?? "session",
    permissions: new Set(opts.permissions),
    ...(accessible
      ? { packageAccessSpacesCache: new Map([[ctx.orgId, Promise.resolve(accessible)]]) }
      : {}),
  };
  return {
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => {
      values[key] = value;
    },
  } as unknown as Context<AppEnv>;
}

const BUILDER_SKILLS = ["skills:read", "skills:write", "skills:delete"];

/** The `ApiError` a call refused with — rethrows anything else, including success. */
async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected a refusal, the call resolved");
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "home" });
  homeId = ctx.defaultSpaceId;
  otherId = (await seedSpace({ orgId: ctx.orgId, name: "Other", visibility: "closed" })).id;
  await seedPackage({
    id: SKILL,
    orgId: ctx.orgId,
    type: "skill",
    homeSpaceId: homeId,
    draftManifest: { name: SKILL, version: "0.1.0", type: "skill" },
    draftContent: "---\nname: secret\ndescription: d\n---\n\nbody",
  });
});

describe("assertPackageMutationAccess", () => {
  it("accepts a builder of the home even when another installation is out of reach", async () => {
    await seedSpacePackage(homeId, SKILL);
    await seedSpacePackage(otherId, SKILL);
    const accessible: AccessibleSpaces = [space(homeId, BUILDER_SKILLS)];
    await assertPackageMutationAccess(
      caller({ orgRole: "member", permissions: BUILDER_SKILLS }, accessible),
      SKILL,
      "write",
    );
  });

  it("refuses a builder of another placement, and says so rather than hiding it", async () => {
    await seedSpacePackage(homeId, SKILL);
    await seedPackageShare(otherId, SKILL);
    await seedSpacePackage(otherId, SKILL);
    // Reachable — the package is OFFERED where they read — but not theirs.
    const accessible: AccessibleSpaces = [space(otherId, BUILDER_SKILLS)];
    const refused = await refusal(
      assertPackageMutationAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }, accessible),
        SKILL,
        "write",
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("home space");
  });

  it("answers 404 when the caller cannot see the package at all", async () => {
    await seedSpacePackage(homeId, SKILL);
    const accessible: AccessibleSpaces = [space(otherId, BUILDER_SKILLS)];
    const refused = await refusal(
      assertPackageMutationAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }, accessible),
        SKILL,
        "write",
      ),
    );
    expect(refused.status).toBe(404);
  });

  it("answers the HOME's permission set and nothing else, whatever the org role", async () => {
    // There is no second authority beside the home any more: an organization's
    // package always has one (`packages_org_package_has_home`), and an admin
    // governs it because `packageAccessSpaces` hands them every team space —
    // which is the `accessible` argument, not a branch in the rule. So the
    // verdict follows the SPACE LIST, and an admin whose list withholds the
    // permission is refused exactly like a member.
    await seedSpacePackage(homeId, SKILL);
    // READ but not write: the refusal has to be the AUTHORITY one (403), not
    // the unreachable-id one (404) a space that reads nothing would produce.
    const without: AccessibleSpaces = [space(homeId, ["skills:read"])];
    const with_: AccessibleSpaces = [space(homeId, BUILDER_SKILLS)];

    for (const orgRole of ["member", "admin", "owner"] as const) {
      const refused = await refusal(
        assertPackageMutationAccess(
          caller({ orgRole, permissions: BUILDER_SKILLS }, without),
          SKILL,
          "write",
        ),
      );
      expect(refused.status, `${orgRole} with no skills:write in the home`).toBe(403);

      await assertPackageMutationAccess(
        caller({ orgRole, permissions: BUILDER_SKILLS }, with_),
        SKILL,
        "write",
      );
    }
  });

  it("refuses when the HOME withholds the permission, whatever the current space grants", async () => {
    await seedSpacePackage(homeId, SKILL);
    // The caller reads the home and nothing more there, while their coarse
    // current-space set carries the full builder bundle. The rule asks the
    // HOME and only the home, so it refuses on the home — and the reverse
    // case, a rich home under a poor current space, is the 200 the route suite
    // pins. Conjoining the two sets instead would refuse on the weaker of
    // them, which is the authority the home rule replaced.
    const accessible: AccessibleSpaces = [space(homeId, ["skills:read"])];
    const refused = await refusal(
      assertPackageMutationAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }, accessible),
        SKILL,
        "delete",
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("home space");
  });

  it("accepts a home that grants it while the current space grants nothing", async () => {
    await seedSpacePackage(homeId, SKILL);
    const accessible: AccessibleSpaces = [space(homeId, BUILDER_SKILLS)];
    // No `permissions` on the context at all: there is no current-space check
    // left to satisfy, which is the whole point of the home rule.
    await assertPackageMutationAccess(
      caller({ orgRole: "member", permissions: [] }, accessible),
      SKILL,
      "write",
    );
  });
});

describe("assertCatalogPackageAccess", () => {
  it("reads a never-installed draft at home", async () => {
    await assertDbCountZeroInstalls();
    const accessible: AccessibleSpaces = [space(homeId, ["skills:read"])];
    const pkg = await assertCatalogPackageAccess(
      caller({ orgRole: "member", permissions: ["skills:read"] }, accessible),
      SKILL,
    );
    expect(pkg.id).toBe(SKILL);
  });

  it("hides that same draft from a space that is not its home", async () => {
    await assertDbCountZeroInstalls();
    const accessible: AccessibleSpaces = [space(otherId, ["skills:read"])];
    const refused = await refusal(
      assertCatalogPackageAccess(
        caller({ orgRole: "member", permissions: ["skills:read"] }, accessible),
        SKILL,
      ),
    );
    expect(refused.status).toBe(404);
  });
});

describe("placementGrantsRead", () => {
  // The ONE predicate behind every read gate (RBAC spec §6.9, §6.10): a
  // package is readable where it is installed, where it is shared, and where it
  // is homed. Called directly — it is pure, and its three disjuncts are what
  // four callers rely on agreeing about.
  const readable = new Set(["spc_a"]);

  it("grants read from the home", () => {
    expect(placementGrantsRead({ homeSpaceId: "spc_a" }, [], readable)).toBe(true);
  });

  it("grants read from a SHARE — the second and last placement", () => {
    expect(placementGrantsRead({ homeSpaceId: "spc_z" }, ["spc_a"], readable)).toBe(true);
  });

  it("refuses when neither the home nor any placement is readable", () => {
    expect(placementGrantsRead({ homeSpaceId: "spc_z" }, ["spc_y"], readable)).toBe(false);
    // A null home is a SYSTEM package or an inline shadow row — the two rows
    // `packages_org_package_has_home` leaves homeless. Neither is placed by
    // this rule: the system escape lives in its callers, and a shadow row is
    // reachable from no package route at all.
    expect(placementGrantsRead({ homeSpaceId: null }, [], readable)).toBe(false);
  });
});

describe("placementGrantsRead ⇄ placementReadFilter — the TS rule and its SQL mirror", () => {
  /**
   * The read rule has two implementations by necessity: `placementGrantsRead`
   * in TypeScript, for the readers that already hold the rows, and
   * `placementReadFilter` in SQL (`services/package-placement.ts`), for the
   * readers that cannot load the organization's catalogue to filter it in
   * memory. Nothing makes them agree except this test, and a THIRD disjunct
   * added to one and not the other drifts silently: a package would be
   * readable on its detail and absent from the space-package listing, the
   * library or the run gate, or the reverse.
   *
   * The SQL side is exercised as the FRAGMENT rather than through an index
   * page, because no index page states it alone any more: the per-type
   * listings render what a space can LAUNCH (`activeHereSql`), which conjoins
   * this filter and then asks the space's switch on top — that composition is
   * `package-activation-parity.test.ts`'s subject. The filter's own readers —
   * the three space-package reads, the integration activation resolution and
   * `activeHereSql` itself — all hand it the same two LEFT JOINs this query
   * does, so pinning it here pins them.
   *
   * The rule has exactly TWO disjuncts — homed here, shared here. The
   * `space_packages` ROW is deliberately a fixture dimension of its own below
   * rather than a third: it must move neither reader, which is what decision 1
   * of `docs/plans/package-placement-unification.md` removed and what a silent
   * re-addition would look like.
   */

  /** Does the SQL fragment read the package as PLACED in `spaceId`? */
  async function placedInSql(spaceId: string, packageId: string): Promise<boolean> {
    const rows = await db
      .select({ id: packages.id })
      .from(packages)
      .leftJoin(
        spacePackages,
        and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, spaceId)),
      )
      .leftJoin(
        packageShares,
        and(eq(packageShares.packageId, packages.id), eq(packageShares.spaceId, spaceId)),
      )
      .where(and(eq(packages.id, packageId), placementReadFilter(spaceId)));
    return rows.length > 0;
  }
  const placements = {
    "with a row only": { row: true, share: false, home: false },
    "shared only": { row: false, share: true, home: false },
    "shared and with a row": { row: true, share: true, home: false },
    "homed only": { row: false, share: false, home: true },
    "placed in neither way here": { row: false, share: false, home: false },
  } as const;

  for (const [label, placement] of Object.entries(placements)) {
    it(`agrees on a package ${label}`, async () => {
      // `otherId` is the space under test. The fixture homes the package in
      // `homeId`, so "homed only" moves it here and the rest leave it at
      // `homeId` — a space the caller's readable set below does not contain,
      // which is what "not homed here" means. It is never NULL: an
      // organization's package always has a home
      // (`packages_org_package_has_home`).
      await db
        .update(packages)
        .set({ homeSpaceId: placement.home ? otherId : homeId })
        .where(eq(packages.id, SKILL));
      if (placement.row) await seedSpacePackage(otherId, SKILL);
      if (placement.share) {
        await db.insert(packageShares).values({ packageId: SKILL, spaceId: otherId });
      }

      // A `space_packages` row is NOT a term of the rule: "with a row only" is
      // expected to read as unplaced, which is the whole point of this pin.
      const expected = placement.share || placement.home;

      // The TS reader, from the same facts the SQL sees.
      expect(
        placementGrantsRead(
          { homeSpaceId: placement.home ? otherId : homeId },
          placement.share ? [otherId] : [],
          new Set([otherId]),
        ),
        `placementGrantsRead on a package ${label}`,
      ).toBe(expected);

      // …and the SQL reader, over the rows themselves.
      expect(await placedInSql(otherId, SKILL), `placementReadFilter on a package ${label}`).toBe(
        expected,
      );
    });
  }

  it("is NOT what the type index page renders — that is the ACTIVE set", async () => {
    // The two rules deliberately DIVERGE, and the divergence is the whole of
    // decision 31: a page that says what this space can LAUNCH must not list a
    // package it merely holds. Homed here AND offered here — the placement
    // rule's strongest hand — and still absent from the index, because no row
    // switches it on. A system package is on by the deployment's default
    // instead, which `space-package-door-semantics` covers.
    await db.update(packages).set({ homeSpaceId: otherId }).where(eq(packages.id, SKILL));
    await db.insert(packageShares).values({ packageId: SKILL, spaceId: otherId });
    expect(await placedInSql(otherId, SKILL)).toBe(true);

    const index = await listOrgItems(ctx.orgId, CONFIG_BY_TYPE.skill, otherId);
    expect(index.map((item) => item.id)).not.toContain(SKILL);

    // And the switch is what puts it there — the positive control without
    // which the assertion above would pass on any refusal at all.
    await seedSpacePackage(otherId, SKILL);
    const afterActivation = await listOrgItems(ctx.orgId, CONFIG_BY_TYPE.skill, otherId);
    expect(afterActivation.map((item) => item.id)).toContain(SKILL);
  });
});

describe("assertCatalogPackageAccess — the share half of the read rule", () => {
  it("reads a package that is only SHARED into a readable space", async () => {
    await assertDbCountZeroInstalls();
    await db.insert(packageShares).values({ packageId: SKILL, spaceId: otherId });
    const accessible: AccessibleSpaces = [space(otherId, ["skills:read"])];
    const pkg = await assertCatalogPackageAccess(
      caller({ orgRole: "member", permissions: ["skills:read"] }, accessible),
      SKILL,
    );
    expect(pkg.id).toBe(SKILL);
  });

  it("still hides it from a space it is neither shared with nor homed in", async () => {
    await db.insert(packageShares).values({ packageId: SKILL, spaceId: otherId });
    const third = (await seedSpace({ orgId: ctx.orgId, name: "Third", visibility: "closed" })).id;
    const refused = await refusal(
      assertCatalogPackageAccess(
        caller({ orgRole: "member", permissions: ["skills:read"] }, [
          space(third, ["skills:read"]),
        ]),
        SKILL,
      ),
    );
    expect(refused.status).toBe(404);
  });
});

describe("assertPackageShareAccess", () => {
  it("accepts `<type>:share` in the home space", async () => {
    const accessible: AccessibleSpaces = [space(homeId, [...BUILDER_SKILLS, "skills:share"])];
    const pkg = await assertPackageShareAccess(
      caller({ orgRole: "member", permissions: [...BUILDER_SKILLS, "skills:share"] }, accessible),
      SKILL,
    );
    expect(pkg.id).toBe(SKILL);
  });

  it("refuses 403 for a caller who reads the home but does not hold `share` there", async () => {
    const accessible: AccessibleSpaces = [space(homeId, BUILDER_SKILLS)];
    const refused = await refusal(
      assertPackageShareAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }, accessible),
        SKILL,
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("skills:share");
  });

  it("refuses 404 when the caller cannot reach the package at all", async () => {
    const accessible: AccessibleSpaces = [space(otherId, [...BUILDER_SKILLS, "skills:share"])];
    const refused = await refusal(
      assertPackageShareAccess(
        caller({ orgRole: "member", permissions: [...BUILDER_SKILLS, "skills:share"] }, accessible),
        SKILL,
      ),
    );
    expect(refused.status).toBe(404);
  });

  it("holds an API key to the same home rule as anybody else", async () => {
    // `share` is absent from the API-key allowlist, so `validateScopes` refuses
    // it at mint time and a key never reaches this with the permission. The
    // fixture hands it one anyway — a key whose space list carries `share` in
    // the home — to pin that the rule itself has no key-specific branch: it
    // answers the home's permission set, and a key that somehow held the
    // permission would be answered like any other principal.
    await seedSpacePackage(homeId, SKILL);
    const key = (accessible: AccessibleSpaces) =>
      caller(
        {
          orgRole: "owner",
          permissions: [...BUILDER_SKILLS, "skills:share"],
          authMethod: "api_key",
        },
        accessible,
      );

    const refused = await refusal(
      assertPackageShareAccess(key([space(homeId, BUILDER_SKILLS)]), SKILL),
    );
    expect(refused.status).toBe(403);

    await assertPackageShareAccess(
      key([space(homeId, [...BUILDER_SKILLS, "skills:share"])]),
      SKILL,
    );
  });
});

/** The fixture installs nothing; this states that, so the two reads above are unambiguous. */
async function assertDbCountZeroInstalls() {
  const rows = await db
    .select({ spaceId: spacePackages.spaceId })
    .from(spacePackages)
    .where(eq(spacePackages.packageId, SKILL));
  expect(rows).toHaveLength(0);
}
