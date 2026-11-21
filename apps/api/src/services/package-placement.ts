// SPDX-License-Identifier: Apache-2.0

/**
 * PLACEMENT: where a package is, distinct from authority and activation
 * (RBAC spec §6.9, §6.10). Placed = homed here, holding a `space_packages` row
 * here, shipped with the deployment, or offered to the space's organization.
 */

import { and, asc, eq, exists, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { orgPackageOffers, packages, schedules, spacePackages, spaces } from "@appstrate/db/schema";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import { disableSchedules } from "./schedules-naming-connection.ts";

const offerSpace = alias(spaces, "offer_space");

/**
 * Drizzle filter: is the package offered to the organization of `spaceId`
 * (`org_package_offers`)? A correlated EXISTS on the outer `packages` row, so
 * no call site joins anything; `spaceId` may be a column of the outer query.
 */
export function offeredToSpaceOrgSql(spaceId: string | AnyPgColumn) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(orgPackageOffers)
      .innerJoin(offerSpace, eq(offerSpace.orgId, orgPackageOffers.orgId))
      .where(and(eq(offerSpace.id, spaceId), eq(orgPackageOffers.packageId, packages.id))),
  );
}

/** Drizzle filter: is the outer `packages` row offered to organization `orgId`? A correlated EXISTS. */
export function offeredToOrgSql(orgId: string) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(orgPackageOffers)
      .where(and(eq(orgPackageOffers.orgId, orgId), eq(orgPackageOffers.packageId, packages.id))),
  );
}

/** The packages offered to `orgId`, narrowed to `packageIds` when given. */
export async function listOrgOffers(
  orgId: string,
  packageIds?: readonly string[],
  executor: DbOrTx = db,
): Promise<Set<string>> {
  if (packageIds?.length === 0) return new Set();
  const rows = await executor
    .select({ packageId: orgPackageOffers.packageId })
    .from(orgPackageOffers)
    .where(
      and(
        eq(orgPackageOffers.orgId, orgId),
        packageIds ? inArray(orgPackageOffers.packageId, [...packageIds]) : undefined,
      ),
    );
  return new Set(rows.map((row) => row.packageId));
}

/** The subset of `packageIds` offered to the organization of `spaceId`: the in-memory twin's input ({@link offeredToSpaceOrgSql}). */
export async function listOfferedToSpaceOrg(
  spaceId: string,
  packageIds: readonly string[],
  executor: DbOrTx = db,
): Promise<Set<string>> {
  if (packageIds.length === 0) return new Set();
  const rows = await executor
    .select({ packageId: orgPackageOffers.packageId })
    .from(orgPackageOffers)
    .innerJoin(spaces, eq(spaces.orgId, orgPackageOffers.orgId))
    .where(and(eq(spaces.id, spaceId), inArray(orgPackageOffers.packageId, [...packageIds])));
  return new Set(rows.map((row) => row.packageId));
}

/**
 * Drizzle filter: is the package placed in `spaceId`? Needs a LEFT JOIN of
 * `spacePackages` on {@link placementRowJoin}; org and shadow filters are the caller's.
 */
export function placementReadFilter(spaceId: string | AnyPgColumn) {
  return or(
    eq(packages.source, "system"),
    isNotNull(spacePackages.packageId),
    eq(packages.homeSpaceId, spaceId),
    offeredToSpaceOrgSql(spaceId),
  );
}

/**
 * The ON clause every placement-aware query joins `spacePackages` with:
 * `(this package, THIS space)`. Dropping the space narrowing silently widens
 * "placed here" to "placed anywhere" (pinned by `package-placement-parity.test.ts`).
 * `spaceId` may be a column when each left row names its own space.
 */
export function placementRowJoin(packageIdColumn: AnyPgColumn, spaceId: string | AnyPgColumn) {
  return and(eq(spacePackages.packageId, packageIdColumn), eq(spacePackages.spaceId, spaceId));
}

/**
 * Is the package placed in any space other than `exceptSpaceId`? Used by the
 * personal-space sweeper (`services/spaces.ts`) to choose re-home over delete.
 * An offer to the organization places it in every space, so it counts: deleting
 * a package the whole organization runs would be worse than re-homing it. The
 * org boundary is the caller's.
 */
export async function isPlacedElsewhere(
  tx: DbOrTx,
  params: { packageId: string; exceptSpaceId: string },
): Promise<boolean> {
  const { packageId, exceptSpaceId } = params;
  const [row] = await tx
    .select({ spaceId: spacePackages.spaceId })
    .from(spacePackages)
    .where(and(eq(spacePackages.packageId, packageId), ne(spacePackages.spaceId, exceptSpaceId)))
    .limit(1);
  if (row) return true;
  const offered = await listOfferedToSpaceOrg(exceptSpaceId, [packageId], tx);
  return offered.has(packageId);
}

/**
 * What a home move (`PUT …/home`) does to the placement it leaves; only the
 * home being left is a choice. Runs inside the caller's transaction.
 *
 * @returns the schedules {@link withdrawPlacement} disabled, whose jobs the
 *   caller removes once committed.
 */
export async function reconcilePlacementsAfterRehome(
  tx: Tx,
  params: {
    packageId: string;
    newHomeSpaceId: string;
    /**
     * The home being left. `keep: true` keeps its row; `keep: false` withdraws
     * it. A space with no row is withdrawn either way (its schedules go off).
     */
    previousHome: { spaceId: string; keep: boolean };
  },
): Promise<string[]> {
  const { packageId, newHomeSpaceId, previousHome } = params;
  if (previousHome.spaceId === newHomeSpaceId) return [];
  if (previousHome.keep) {
    const [row] = await tx
      .select({ packageId: spacePackages.packageId })
      .from(spacePackages)
      .where(
        and(
          eq(spacePackages.packageId, packageId),
          eq(spacePackages.spaceId, previousHome.spaceId),
        ),
      )
      .limit(1);
    if (row) return [];
  }
  return (await withdrawPlacement(tx, packageId, previousHome.spaceId)).disabledScheduleIds;
}

/**
 * Disable, with `package_removed`, every armed schedule matching `where`,
 * locking them first. The one place a placement loss turns schedules off.
 *
 * @returns the disabled schedule ids, whose jobs the caller removes once committed.
 */
export async function disableArmedSchedules(tx: Tx, where: SQL | undefined): Promise<string[]> {
  const armed = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(where, eq(schedules.enabled, true)))
    .orderBy(asc(schedules.id))
    .for("update");
  const ids = armed.map((row) => row.id);
  await disableSchedules(tx, ids, "package_removed");
  return ids;
}

/**
 * Withdraw `packageId` from `spaceId`: the one delete of a `space_packages` row
 * (settings included). Every schedule of the package there is disabled with
 * `package_removed` in the same transaction; re-placing does not re-arm them.
 * A package offered to the organization stays placed (and active) in the space
 * without a row, so its schedules are left armed. The org boundary is the
 * caller's.
 *
 * @returns whether a row went, and the disabled schedules, whose jobs the
 *   caller removes once committed.
 */
export async function withdrawPlacement(
  tx: Tx,
  packageId: string,
  spaceId: string,
): Promise<{ removed: boolean; disabledScheduleIds: string[] }> {
  const removed = await tx
    .delete(spacePackages)
    .where(and(eq(spacePackages.packageId, packageId), eq(spacePackages.spaceId, spaceId)))
    .returning({ packageId: spacePackages.packageId });
  if ((await listOfferedToSpaceOrg(spaceId, [packageId], tx)).has(packageId)) {
    return { removed: removed.length > 0, disabledScheduleIds: [] };
  }
  const disabledScheduleIds = await disableArmedSchedules(
    tx,
    and(eq(schedules.packageId, packageId), eq(schedules.spaceId, spaceId)),
  );
  return { removed: removed.length > 0, disabledScheduleIds };
}
