// SPDX-License-Identifier: Apache-2.0

/**
 * PLACEMENT: where a package is, distinct from authority and activation
 * (RBAC spec §6.9, §6.10). Placed = homed here, holding a `space_packages` row
 * here, or shipped with the deployment.
 */

import { and, asc, eq, isNotNull, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { packages, schedules, spacePackages } from "@appstrate/db/schema";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import { disableSchedules } from "./schedules-naming-connection.ts";

/**
 * Drizzle filter: is the package placed in `spaceId`? Needs a LEFT JOIN of
 * `spacePackages` on {@link placementRowJoin}; org and shadow filters are the caller's.
 */
export function placementReadFilter(spaceId: string) {
  return or(
    eq(packages.source, "system"),
    isNotNull(spacePackages.packageId),
    eq(packages.homeSpaceId, spaceId),
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
 * The org boundary is the caller's.
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
  return !!row;
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
 * Withdraw `packageId` from `spaceId`: the one delete of a `space_packages` row
 * (settings included). Every schedule of the package there is disabled with
 * `package_removed` in the same transaction; re-placing does not re-arm them.
 * The org boundary is the caller's.
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
  const armed = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        eq(schedules.packageId, packageId),
        eq(schedules.spaceId, spaceId),
        eq(schedules.enabled, true),
      ),
    )
    .orderBy(asc(schedules.id))
    .for("update");
  const disabledScheduleIds = armed.map((row) => row.id);
  await disableSchedules(tx, disabledScheduleIds, "package_removed");
  return { removed: removed.length > 0, disabledScheduleIds };
}
