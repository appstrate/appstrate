// SPDX-License-Identifier: Apache-2.0

/**
 * WHERE a package is — PLACEMENT, the axis that is neither authority (who may
 * write it) nor activation (does this space run it).
 *
 * A package is placed in the space that HOMES it, in every space holding a
 * `space_packages` row for it, and — by construction — in every space of every
 * organization when the deployment ships it (RBAC spec §6.9, §6.10). This
 * module states that rule in SQL ({@link placementReadFilter}), owns the ON
 * clause it is read through, and owns what a home move does to the placement
 * it leaves ({@link reconcilePlacementsAfterRehome}).
 */

import { and, asc, eq, isNotNull, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { packages, schedules, spacePackages } from "@appstrate/db/schema";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import { disableSchedules } from "./schedules-naming-connection.ts";

/**
 * Drizzle filter: is the package PLACED in `spaceId`? — shipped with the
 * deployment, homed here, or holding a row here, each a read grant on its own.
 *
 * Reads its row half off a LEFT JOIN of `spacePackages`, whose ON clause is
 * {@link placementRowJoin}. The org boundary (`orgOrSystemFilter`) and the
 * shadow filter (`notEphemeralFilter`) are the caller's, as everywhere else.
 */
export function placementReadFilter(spaceId: string) {
  return or(
    eq(packages.source, "system"),
    isNotNull(spacePackages.packageId),
    eq(packages.homeSpaceId, spaceId),
  );
}

/**
 * The ON clause every placement-aware query joins `spacePackages` with —
 * `(this package, THIS space)`. {@link placementReadFilter} reads its row half
 * off it, `activeHereSql` (`services/package-activation.ts`) reads the space's
 * decision, and the listings project `enabled` and the per-space overrides.
 *
 * The space narrowing is the whole function. Dropping it widens "placed in THIS
 * space" into "placed in any space at all", in every reader at once, and
 * raises nothing — so `spaceId` is a required argument and
 * `package-placement-parity.test.ts` pins the widening with a package placed
 * elsewhere. `spaceId` is a column when each left row names its own space (a
 * schedule's).
 *
 * `packageIdColumn` is the left-hand side because the readers join from two
 * different tables — `packages.id` on the catalogue reads, and
 * `spacePackages.packageId` on the ones that start from another space's row.
 */
export function placementRowJoin(packageIdColumn: AnyPgColumn, spaceId: string | AnyPgColumn) {
  return and(eq(spacePackages.packageId, packageIdColumn), eq(spacePackages.spaceId, spaceId));
}

/**
 * Is the package placed in ANY space of the organization other than
 * `exceptSpaceId`? — the rule above, asked as an existence question.
 *
 * The caller is the offboarding sweeper (`emptyAndDeletePersonalSpace`,
 * `services/spaces.ts`), deciding whether a package homed in a departing
 * member's personal space is re-homed or deleted. `exceptSpaceId` is that
 * space: its home placement is the one leaving, so neither it nor a row sitting
 * in it may answer for itself.
 *
 * The org boundary is the caller's. An inherited cross-org row would answer
 * "placed" and get the package re-homed rather than deleted — the conservative
 * direction.
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
 * What a home MOVE (`PUT /api/packages/{scope}/{name}/home`) does to the
 * placement it leaves.
 *
 * Every space holding a row keeps it, and the row keeps placing the package
 * there: nothing to write. The one space whose answer is a CHOICE is the home
 * being left (`previousHome` below). The other writer of `home_space_id`, the
 * personal-space sweeper (`emptyAndDeletePersonalSpace`, `services/spaces.ts`),
 * deletes the space it re-homes out of, so it has nothing to reconcile.
 *
 * Runs INSIDE the caller's transaction (`PUT /api/packages/{scope}/{name}/home`):
 * the move and the placement it releases commit together or not at all.
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
     * The home being LEFT, and what becomes of its placement. `PUT …/home`
     * passes a human's answer for it.
     *
     * `keep: true` leaves its row where it is: the row places the package
     * there from now on.
     *
     * `keep: false` withdraws it ({@link withdrawPlacement}) — the act
     * `revokePackageShare` performs for any other space. A space that held no
     * row is withdrawn from whatever the flag says: nothing places the package
     * there once the home has moved, so its schedules go off all the same.
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
 * Withdraw the placement of `packageId` from `spaceId` — the ONE delete of a
 * `space_packages` row, settings and all, for both acts that withdraw one
 * (`revokePackageShare`, {@link reconcilePlacementsAfterRehome}).
 *
 * The package is gone from the space, so EVERY schedule of it there is
 * disabled in the same transaction rather than left armed to fail each fire
 * with "not placed" — whoever's they are, as a connection unshare disables the
 * schedules naming it. Locked in id order, in one statement
 * (`schedules-naming-connection.ts`), with `package_removed`: re-placing the
 * package does not re-arm a schedule on its own.
 *
 * The org boundary is the caller's (`spaceId` is one of its spaces).
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
