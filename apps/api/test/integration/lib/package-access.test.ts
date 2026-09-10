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
  packageAccessSpaces,
} from "../../../src/lib/package-access.ts";
import type { Permission } from "../../../src/lib/permissions.ts";
import type { AppEnv } from "../../../src/types/index.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedInstalledPackage, seedPackage, seedSpace } from "../../helpers/seed.ts";

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

/** The fixture installs nothing; this states that, so the two reads above are unambiguous. */
async function assertDbCountZeroInstalls() {
  const rows = await db
    .select({ spaceId: spacePackages.spaceId })
    .from(spacePackages)
    .where(eq(spacePackages.packageId, SKILL));
  expect(rows).toHaveLength(0);
}
