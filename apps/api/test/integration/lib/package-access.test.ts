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
import { eq } from "drizzle-orm";
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
import { seedInstalledPackage, seedPackage, seedSpace } from "../../helpers/seed.ts";
import { packageShares } from "@appstrate/db/schema";
import { listOrgItems } from "../../../src/services/package-items/crud.ts";
import { CONFIG_BY_TYPE } from "../../../src/services/package-items/config.ts";

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
 * The caller. `orgRole` + `authMethod` decide `managesOrgCatalog`; `permissions`
 * is the coarse guard the route pipeline would have set for the current space.
 */
function caller(opts: {
  orgRole: "owner" | "admin" | "member" | "guest";
  permissions: string[];
  authMethod?: string;
}): Context<AppEnv> {
  const values: Record<string, unknown> = {
    orgId: ctx.orgId,
    orgRole: opts.orgRole,
    authMethod: opts.authMethod ?? "session",
    permissions: new Set(opts.permissions),
  };
  return { get: (key: string) => values[key] } as unknown as Context<AppEnv>;
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
    await seedInstalledPackage(homeId, SKILL);
    await seedInstalledPackage(otherId, SKILL);
    const accessible: AccessibleSpaces = [space(homeId, BUILDER_SKILLS)];
    await assertPackageMutationAccess(
      caller({ orgRole: "member", permissions: BUILDER_SKILLS }),
      SKILL,
      "write",
      accessible,
    );
  });

  it("refuses a builder of another installation, and says so rather than hiding it", async () => {
    await seedInstalledPackage(homeId, SKILL);
    await seedInstalledPackage(otherId, SKILL);
    // Reachable — the package is installed where they read — but not theirs.
    const accessible: AccessibleSpaces = [space(otherId, BUILDER_SKILLS)];
    const refused = await refusal(
      assertPackageMutationAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }),
        SKILL,
        "write",
        accessible,
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("home space");
  });

  it("answers 404 when the caller cannot see the package at all", async () => {
    await seedInstalledPackage(homeId, SKILL);
    const accessible: AccessibleSpaces = [space(otherId, BUILDER_SKILLS)];
    const refused = await refusal(
      assertPackageMutationAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }),
        SKILL,
        "write",
        accessible,
      ),
    );
    expect(refused.status).toBe(404);
  });

  it("reserves a package with no home to owners and admins on a session", async () => {
    await db.update(packages).set({ homeSpaceId: null }).where(eq(packages.id, SKILL));
    await seedInstalledPackage(homeId, SKILL);
    const accessible: AccessibleSpaces = [space(homeId, BUILDER_SKILLS)];

    const refused = await refusal(
      assertPackageMutationAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }),
        SKILL,
        "write",
        accessible,
      ),
    );
    expect(refused.status).toBe(403);

    await assertPackageMutationAccess(
      caller({ orgRole: "admin", permissions: BUILDER_SKILLS }),
      SKILL,
      "write",
      accessible,
    );

    // Never an API key: it is pinned to one space and the catalog is org-wide.
    const keyRefused = await refusal(
      assertPackageMutationAccess(
        caller({ orgRole: "owner", permissions: BUILDER_SKILLS, authMethod: "api_key" }),
        SKILL,
        "write",
        accessible,
      ),
    );
    expect(keyRefused.status).toBe(403);
  });

  it("refuses when the HOME withholds the permission, whatever the current space grants", async () => {
    await seedInstalledPackage(homeId, SKILL);
    // The caller reads the home and nothing more there, while their coarse
    // current-space set carries the full builder bundle. The old rule asked
    // both and refused on the weaker; the rule asks the home, so it refuses on
    // the home — and the reverse case, a rich home under a poor current space,
    // is the 200 the route suite pins.
    const accessible: AccessibleSpaces = [space(homeId, ["skills:read"])];
    const refused = await refusal(
      assertPackageMutationAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }),
        SKILL,
        "delete",
        accessible,
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("home space");
  });

  it("accepts a home that grants it while the current space grants nothing", async () => {
    await seedInstalledPackage(homeId, SKILL);
    const accessible: AccessibleSpaces = [space(homeId, BUILDER_SKILLS)];
    // No `permissions` on the context at all: there is no current-space check
    // left to satisfy, which is the whole point of the home rule.
    await assertPackageMutationAccess(
      caller({ orgRole: "member", permissions: [] }),
      SKILL,
      "write",
      accessible,
    );
  });
});

describe("assertCatalogPackageAccess", () => {
  it("reads a never-installed draft at home", async () => {
    await assertDbCountZeroInstalls();
    const accessible: AccessibleSpaces = [space(homeId, ["skills:read"])];
    const pkg = await assertCatalogPackageAccess(
      caller({ orgRole: "member", permissions: ["skills:read"] }),
      SKILL,
      accessible,
    );
    expect(pkg.id).toBe(SKILL);
  });

  it("hides that same draft from a space that is not its home", async () => {
    await assertDbCountZeroInstalls();
    const accessible: AccessibleSpaces = [space(otherId, ["skills:read"])];
    const refused = await refusal(
      assertCatalogPackageAccess(
        caller({ orgRole: "member", permissions: ["skills:read"] }),
        SKILL,
        accessible,
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

  it("grants read from a PLACEMENT — installed or shared, the same disjunct", () => {
    expect(placementGrantsRead({ homeSpaceId: "spc_z" }, ["spc_a"], readable)).toBe(true);
  });

  it("refuses when neither the home nor any placement is readable", () => {
    expect(placementGrantsRead({ homeSpaceId: "spc_z" }, ["spc_y"], readable)).toBe(false);
    expect(placementGrantsRead({ homeSpaceId: null }, [], readable)).toBe(false);
  });
});

describe("placementGrantsRead ⇄ listOrgItems — the TS rule and its SQL mirror", () => {
  /**
   * The read rule has two implementations by necessity: `placementGrantsRead`
   * in TypeScript, for the readers that already hold the rows, and the
   * `installFilter` disjunction inside `listOrgItems` (`package-items/crud.ts`),
   * because the per-type index page cannot load the organization's catalogue to
   * filter it in memory. Nothing makes them agree except this test, and a
   * FOURTH disjunct added to one and not the other drifts silently: a package
   * would be readable on its detail and absent from the page a reader would go
   * looking for it on, or the reverse.
   *
   * Each fixture below places the package one way and asserts BOTH readers on
   * it, from the same rows.
   */
  const placements = {
    "installed only": { install: true, share: false, home: false },
    "shared only": { install: false, share: true, home: false },
    "homed only": { install: false, share: false, home: true },
    "placed nowhere": { install: false, share: false, home: false },
  } as const;

  for (const [label, placement] of Object.entries(placements)) {
    it(`agrees on a package ${label}`, async () => {
      // `otherId` is the space under test. The fixture homes the package in
      // `homeId`, so "homed only" moves it here and the other three take it
      // away from every space this caller looks at.
      await db
        .update(packages)
        .set({ homeSpaceId: placement.home ? otherId : null })
        .where(eq(packages.id, SKILL));
      if (placement.install) await seedInstalledPackage(otherId, SKILL);
      if (placement.share) {
        await db.insert(packageShares).values({ packageId: SKILL, spaceId: otherId });
      }

      const expected = placement.install || placement.share || placement.home;

      // The TS reader, from the same three facts the SQL sees.
      const placedIn = [
        ...(placement.install ? [otherId] : []),
        ...(placement.share ? [otherId] : []),
      ];
      expect(
        placementGrantsRead(
          { homeSpaceId: placement.home ? otherId : null },
          placedIn,
          new Set([otherId]),
        ),
        `placementGrantsRead on a package ${label}`,
      ).toBe(expected);

      // …and the SQL reader, over the rows themselves.
      const listed = await listOrgItems(ctx.orgId, CONFIG_BY_TYPE.skill, otherId);
      expect(
        listed.map((item) => item.id).includes(SKILL),
        `listOrgItems on a package ${label}`,
      ).toBe(expected);
    });
  }

  it("keeps `activeOnly` install-only — neither a home nor an offer is an instance", async () => {
    // The one place the two rules deliberately DIVERGE, so it is pinned rather
    // than left to be discovered: the integration picker asks for usable
    // instances, and a package merely homed or offered here is not one.
    await db.update(packages).set({ homeSpaceId: otherId }).where(eq(packages.id, SKILL));
    await db.insert(packageShares).values({ packageId: SKILL, spaceId: otherId });
    const active = await listOrgItems(ctx.orgId, CONFIG_BY_TYPE.skill, otherId, {
      activeOnly: true,
    });
    expect(active.map((item) => item.id)).not.toContain(SKILL);
  });
});

describe("assertCatalogPackageAccess — the share half of the read rule", () => {
  it("reads a package that is only SHARED into a readable space", async () => {
    await assertDbCountZeroInstalls();
    await db.insert(packageShares).values({ packageId: SKILL, spaceId: otherId });
    const accessible: AccessibleSpaces = [space(otherId, ["skills:read"])];
    const pkg = await assertCatalogPackageAccess(
      caller({ orgRole: "member", permissions: ["skills:read"] }),
      SKILL,
      accessible,
    );
    expect(pkg.id).toBe(SKILL);
  });

  it("still hides it from a space it is neither shared with nor homed in", async () => {
    await db.insert(packageShares).values({ packageId: SKILL, spaceId: otherId });
    const third = (await seedSpace({ orgId: ctx.orgId, name: "Third", visibility: "closed" })).id;
    const refused = await refusal(
      assertCatalogPackageAccess(
        caller({ orgRole: "member", permissions: ["skills:read"] }),
        SKILL,
        [space(third, ["skills:read"])],
      ),
    );
    expect(refused.status).toBe(404);
  });
});

describe("assertPackageShareAccess", () => {
  it("accepts `<type>:share` in the home space", async () => {
    const accessible: AccessibleSpaces = [space(homeId, [...BUILDER_SKILLS, "skills:share"])];
    const pkg = await assertPackageShareAccess(
      caller({ orgRole: "member", permissions: [...BUILDER_SKILLS, "skills:share"] }),
      SKILL,
      accessible,
    );
    expect(pkg.id).toBe(SKILL);
  });

  it("refuses 403 for a caller who reads the home but does not hold `share` there", async () => {
    const accessible: AccessibleSpaces = [space(homeId, BUILDER_SKILLS)];
    const refused = await refusal(
      assertPackageShareAccess(
        caller({ orgRole: "member", permissions: BUILDER_SKILLS }),
        SKILL,
        accessible,
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("skills:share");
  });

  it("refuses 404 when the caller cannot reach the package at all", async () => {
    const accessible: AccessibleSpaces = [space(otherId, [...BUILDER_SKILLS, "skills:share"])];
    const refused = await refusal(
      assertPackageShareAccess(
        caller({ orgRole: "member", permissions: [...BUILDER_SKILLS, "skills:share"] }),
        SKILL,
        accessible,
      ),
    );
    expect(refused.status).toBe(404);
  });

  it("refuses an API key even when its space list carries `share`", async () => {
    // Belt and braces: `share` is absent from the API-key allowlist so a key
    // can never carry it, and a NULL-home package additionally answers to
    // `managesOrgCatalog`, which refuses key auth outright.
    await db.update(packages).set({ homeSpaceId: null }).where(eq(packages.id, SKILL));
    await seedInstalledPackage(homeId, SKILL);
    const accessible: AccessibleSpaces = [space(homeId, [...BUILDER_SKILLS, "skills:share"])];
    const refused = await refusal(
      assertPackageShareAccess(
        caller({
          orgRole: "owner",
          permissions: [...BUILDER_SKILLS, "skills:share"],
          authMethod: "api_key",
        }),
        SKILL,
        accessible,
      ),
    );
    expect(refused.status).toBe(403);
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
