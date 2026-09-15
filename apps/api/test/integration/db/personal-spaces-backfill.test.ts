// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import {
  organizationMembers,
  packages,
  packageShares,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedSpacePackage, seedPackage, seedSpace } from "../../helpers/seed.ts";

async function backfill(file: string) {
  const script = await Bun.file(
    new URL(`../../../../../scripts/migration/${file}`, import.meta.url),
  ).text();
  const embedded = getPGliteClient();
  if (embedded) {
    await embedded.exec(script);
    return;
  }
  const connection = await reservePgConnection();
  if (!connection) throw new Error("PostgreSQL test connection unavailable");
  try {
    await connection.sql.unsafe(script).simple();
  } finally {
    connection.release();
  }
}

describe("personal-space rollout scripts on migrated data", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("assigns homes within the org, leaves uninstalled packages alone and preserves operator choices on replay", async () => {
    const newer = await seedSpace({ orgId: ctx.orgId });
    for (const name of ["single", "multiple", "uninstalled"]) {
      await seedPackage({ id: `@backfill/${name}`, orgId: ctx.orgId, type: "agent" });
    }
    await seedSpacePackage(ctx.defaultSpaceId, "@backfill/single");
    await seedSpacePackage(ctx.defaultSpaceId, "@backfill/multiple", {
      installedAt: new Date("2020-01-01"),
    });
    await seedSpacePackage(newer.id, "@backfill/multiple", {
      installedAt: new Date("2021-01-01"),
    });
    await backfill("0014-packages-home-space-backfill.sql");
    const rows = await db
      .select({ id: packages.id, home: packages.homeSpaceId })
      .from(packages)
      .where(eq(packages.orgId, ctx.orgId));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.home]))).toEqual({
      "@backfill/single": ctx.defaultSpaceId,
      "@backfill/multiple": ctx.defaultSpaceId,
      "@backfill/uninstalled": null,
    });
    await db
      .update(packages)
      .set({ homeSpaceId: newer.id })
      .where(eq(packages.id, "@backfill/multiple"));
    await backfill("0014-packages-home-space-backfill.sql");
    const [moved] = await db.select().from(packages).where(eq(packages.id, "@backfill/multiple"));
    expect(moved!.homeSpaceId).toBe(newer.id);
  });

  it("gives every installation outside its package's home the share that now places it", async () => {
    // 0016 is the migration the placement rule needs: from the release that
    // drops the installed-here term, a package is readable from a space through
    // its HOME or a `package_shares` row and nothing else. Without this script
    // every pre-existing team installation vanishes from its space at the first
    // request — still installed, still running for a schedule, invisible on
    // every page.
    const home = await seedSpace({ orgId: ctx.orgId });
    const teamA = await seedSpace({ orgId: ctx.orgId });
    const teamB = await seedSpace({ orgId: ctx.orgId });
    // Another organization's space, to prove the script never crosses the
    // tenant boundary through `space_packages` (which carries no `org_id`).
    const foreign = await createTestContext({ orgSlug: "otherorg" });

    await seedPackage({ id: "@backfill/homed", orgId: ctx.orgId, homeSpaceId: home.id });
    // A NULL home — the organization catalogue. Installed somewhere, it needs
    // the share as much as a homed package does: the catalogue is not a
    // placement in any particular space.
    await seedPackage({ id: "@backfill/catalogue", orgId: ctx.orgId });
    await seedPackage({ id: "@sys/tool", orgId: null, source: "system" });

    // Two installations OUTSIDE the home, one INSIDE it, one system package.
    await seedSpacePackage(teamA.id, "@backfill/homed");
    await seedSpacePackage(teamB.id, "@backfill/catalogue");
    await seedSpacePackage(home.id, "@backfill/homed");
    await seedSpacePackage(teamA.id, "@sys/tool");
    // A cross-tenant stray: the row exists, the space belongs to another org.
    await seedSpacePackage(foreign.defaultSpaceId, "@backfill/homed");

    const shares = async () =>
      (await db.select().from(packageShares))
        .map((row) => `${row.packageId}@${row.spaceId}`)
        .sort();

    await backfill("0016-package-shares-backfill.sql");
    const after = await shares();
    expect(after).toEqual(
      [`@backfill/homed@${teamA.id}`, `@backfill/catalogue@${teamB.id}`].sort(),
    );
    // `shared_by` is NULL: nobody offered these — the installation predates the
    // rule, and no `package.shared` audit event stands behind it.
    for (const row of await db.select().from(packageShares)) {
      expect(row.sharedBy).toBeNull();
    }

    // The script's own "after" query, which the runbook requires to print 0.
    const [remaining] = await db
      .select({ packageId: spacePackages.packageId, spaceId: spacePackages.spaceId })
      .from(spacePackages)
      .innerJoin(packages, eq(packages.id, spacePackages.packageId))
      .innerJoin(
        spaces,
        and(eq(spaces.id, spacePackages.spaceId), eq(spaces.orgId, packages.orgId))!,
      )
      .leftJoin(
        packageShares,
        and(
          eq(packageShares.packageId, spacePackages.packageId),
          eq(packageShares.spaceId, spacePackages.spaceId),
        ),
      )
      .where(
        and(
          isNotNull(packages.orgId),
          eq(packages.ephemeral, false),
          or(isNull(packages.homeSpaceId), ne(packages.homeSpaceId, spacePackages.spaceId)),
          isNull(packageShares.packageId),
        ),
      )
      .limit(1);
    expect(remaining).toBeUndefined();

    // Idempotent: the primary key guards the insert, so a replay is a no-op.
    await backfill("0016-package-shares-backfill.sql");
    expect(await shares()).toEqual(after);
  });

  it("provisions exactly one private space per live membership and does not revive an orphan on replay", async () => {
    const departed = await createTestUser();
    const orphan = await seedSpace({
      orgId: ctx.orgId,
      ownerUserId: departed.id,
      visibility: "private",
      orphanedAt: new Date(),
    });
    const liveMembers = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, ctx.orgId));
    await backfill("0015-personal-spaces-backfill.sql");
    const readPersonal = () =>
      db
        .select()
        .from(spaces)
        .where(and(eq(spaces.orgId, ctx.orgId), isNotNull(spaces.ownerUserId)));
    const first = await readPersonal();
    expect(first).toHaveLength(liveMembers.length + 1);
    for (const row of first) {
      expect(row.visibility).toBe("private");
      expect(row.isDefault).toBe(false);
    }
    await backfill("0015-personal-spaces-backfill.sql");
    const replayed = await readPersonal();
    expect(replayed.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(replayed.find((row) => row.id === orphan.id)!.orphanedAt).not.toBeNull();
  });
});
