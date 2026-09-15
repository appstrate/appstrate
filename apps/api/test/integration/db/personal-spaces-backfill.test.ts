// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  organizationMembers,
  packages,
  packageShares,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { getPGliteClient, reservePgConnection, toRows } from "@appstrate/db/client";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedSpacePackage, seedPackage, seedSpace } from "../../helpers/seed.ts";

async function execScript(script: string) {
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

async function backfill(file: string) {
  await execScript(
    await Bun.file(new URL(`../../../../../scripts/migration/${file}`, import.meta.url)).text(),
  );
}

/**
 * The state `0014` exists to repair, which a migrated database can no longer be
 * put into by an INSERT: `packages_org_package_has_home` (`0067`) governs every
 * write from the moment it is added. Production reaches `0014` with the
 * constraint present but UNVALIDATED and every `home_space_id` NULL, so the
 * fixture reproduces exactly that — drop, seed the legacy rows, re-add `NOT
 * VALID` — and `0014`'s closing `VALIDATE CONSTRAINT` is then the real thing
 * rather than a formality.
 */
const HOME_CONSTRAINT = "packages_org_package_has_home";
async function withUnvalidatedHomeConstraint(seed: () => Promise<void>): Promise<void> {
  await execScript(`ALTER TABLE packages DROP CONSTRAINT ${HOME_CONSTRAINT};`);
  try {
    await seed();
  } finally {
    await execScript(
      `ALTER TABLE packages ADD CONSTRAINT ${HOME_CONSTRAINT} ` +
        `CHECK ("packages"."org_id" IS NULL OR "packages"."ephemeral" OR ` +
        `"packages"."home_space_id" IS NOT NULL) NOT VALID;`,
    );
  }
}

/** Is the home constraint marked VALIDATED — i.e. did `0014` take its second half? */
async function homeConstraintValidated(): Promise<boolean> {
  const rows = toRows<{ convalidated: boolean }>(
    await db.execute(
      sql`SELECT convalidated FROM pg_constraint WHERE conname = ${HOME_CONSTRAINT}`,
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.convalidated;
}

describe("personal-space rollout scripts on migrated data", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("assigns homes within the org, sends the uninstalled to the DEFAULT space and preserves operator choices on replay", async () => {
    const newer = await seedSpace({ orgId: ctx.orgId });
    await withUnvalidatedHomeConstraint(async () => {
      for (const name of ["single", "multiple", "uninstalled"]) {
        await seedPackage({
          id: `@backfill/${name}`,
          orgId: ctx.orgId,
          type: "agent",
          homeSpaceId: null,
        });
      }
    });
    expect(await homeConstraintValidated()).toBe(false);
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
      // Installed in exactly one space → that space.
      "@backfill/single": ctx.defaultSpaceId,
      // Installed in two → the OLDEST installation.
      "@backfill/multiple": ctx.defaultSpaceId,
      // Installed nowhere → the organization's DEFAULT space, never NULL: a
      // package nobody can write is the state this script exists to end.
      "@backfill/uninstalled": ctx.defaultSpaceId,
    });
    // The script's last statement took the other half of the constraint, which
    // is the only thing that makes the rows it did NOT touch a guarantee.
    expect(await homeConstraintValidated()).toBe(true);

    await db
      .update(packages)
      .set({ homeSpaceId: newer.id })
      .where(eq(packages.id, "@backfill/multiple"));
    await backfill("0014-packages-home-space-backfill.sql");
    const [moved] = await db.select().from(packages).where(eq(packages.id, "@backfill/multiple"));
    expect(moved!.homeSpaceId).toBe(newer.id);
    expect(await homeConstraintValidated()).toBe(true);
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
    // Homed in the organization's DEFAULT space — where `0014` puts a package
    // that belongs to no team, and the shape every row has by the time this
    // script runs. Installed in a space that is not its home, it needs the
    // share exactly like the one above.
    await seedPackage({ id: "@backfill/teamless", orgId: ctx.orgId });
    await seedPackage({ id: "@sys/tool", orgId: null, source: "system" });

    // Two installations OUTSIDE the home, one INSIDE it, one system package.
    await seedSpacePackage(teamA.id, "@backfill/homed");
    await seedSpacePackage(teamB.id, "@backfill/teamless");
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
    expect(after).toEqual([`@backfill/homed@${teamA.id}`, `@backfill/teamless@${teamB.id}`].sort());
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
          // The script's own predicate: `0014` runs first, so there is no NULL
          // home left to test for and a plain `<>` is the whole home check.
          ne(packages.homeSpaceId, spacePackages.spaceId),
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
