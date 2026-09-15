// SPDX-License-Identifier: Apache-2.0

/**
 * WHERE a package is — PLACEMENT, the axis that is neither authority (who may
 * write it) nor activation (does this space run it).
 *
 * Two placements and no third (RBAC spec §6.9, §6.10): a package is placed in
 * the space that HOMES it and in every space it is SHARED with, plus — by
 * construction — in every space of every organization when the deployment
 * ships it. This module states that rule in SQL ({@link placementReadFilter})
 * and owns the ONE act that has to repair it: re-homing a package moves one of
 * the two placements, and every space that held the old one needs the other or
 * it is left with a `space_packages` row nothing places
 * ({@link reconcilePlacementsAfterRehome}).
 *
 * It is a leaf on purpose. `services/package-activation.ts` conjoins the read
 * filter into "active here" (a row only speaks for a space the package is
 * placed in), `services/package-items/crud.ts` and
 * `services/space-packages.ts` filter their listings with it, and both the
 * home MOVE (`routes/packages.ts`) and the personal-space sweeper
 * (`services/spaces.ts`) call the reconciliation. None of those can be
 * imported back from here, which is exactly why the rule lives in a module
 * that imports nothing of theirs.
 */

import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import { packages, packageShares, spacePackages, spaces } from "@appstrate/db/schema";
import type { DbOrTx } from "../lib/db-helpers.ts";

/**
 * Drizzle filter: is the package PLACED in `spaceId`?
 *
 * Homed here, offered here, or shipped with the deployment — the three, and
 * the reason each one grants read on its own. The HOME is a grant of its own:
 * a draft nobody has offered yet is readable where it lives, and without it
 * write authority would exceed read access — a builder able to `PUT` a package
 * they cannot `GET`. The SHARE half is the audience rule, and it has to grant
 * read BEFORE anything is switched on: an offer the recipient has not taken up
 * still shows them its name, its description and the switch that would
 * activate it.
 *
 * A PLACEMENT ROW (`space_packages`) is deliberately not a fourth one. It is
 * the only candidate that would answer "why does this space see this package"
 * without consulting `<type>:share`: a builder of B who reads A's package
 * anywhere would activate it in B and hand B a placement A granted to nobody.
 * Activating is the act of TAKING an offer, so a row is a placement's
 * consequence and never its source — which is why `activeHereSql` conjoins
 * THIS filter rather than trusting the row alone.
 *
 * Expects `packageShares` LEFT JOINed on (package, `spaceId`) — the share half
 * is `packageShares.packageId IS NOT NULL`, so a query that omits the join
 * silently loses it. The org boundary (`orgOrSystemFilter`) and the shadow
 * filter (`notEphemeralFilter`) are the caller's, as everywhere else.
 */
export function placementReadFilter(spaceId: string) {
  return or(
    eq(packages.source, "system"),
    isNotNull(packageShares.packageId),
    eq(packages.homeSpaceId, spaceId),
  );
}

/**
 * Re-home a package and leave no placement behind — the ONE reconciliation,
 * called by everything that rewrites `packages.home_space_id`.
 *
 * A package is placed in a space by its home or by a share. Moving the home
 * OUT of a space that still holds a `space_packages` row would leave a
 * placement nothing places: invisible on every page of the space that runs it,
 * absent from its own index, and — until the doors learned to ask — still
 * firing from a cron. That is the exact state `scripts/migration/0016` exists
 * to repair on inherited data, and no live code path may create another one.
 *
 * So: every space of the organization holding a row, other than the NEW home,
 * gets the share that now places it, `shared_by` NULL because nobody offered
 * it — the home did, until this call. And the destination's own share is
 * dropped for the mirror-image reason `POST …/shares` answers
 * `share_target_is_home`: a package is not offered to the space it lives in.
 *
 * Two callers, one shape, and the second is why this is a function rather than
 * a paragraph inside the first: `PATCH /api/packages/{scope}/{name}` moves a
 * home deliberately, and `emptyAndDeletePersonalSpace`
 * (`services/spaces.ts`) moves one because the author left — a package still
 * running elsewhere is re-homed to the organization's DEFAULT space. The
 * second produced orphans for as long as it did not share this code.
 *
 * Runs INSIDE the caller's transaction, always: the move and the placements it
 * invalidates commit together or not at all. Call it AFTER the
 * `packages.home_space_id` write, so a concurrent activation that waits on
 * that row's lock re-reads the home it will actually be judged against.
 */
export async function reconcilePlacementsAfterRehome(
  tx: DbOrTx,
  params: { packageId: string; orgId: string; newHomeSpaceId: string },
): Promise<void> {
  const { packageId, orgId, newHomeSpaceId } = params;

  // The `spaces` join is the org boundary: `space_packages` carries no
  // `org_id`, and an offer must never be written for a space another
  // organization owns.
  const orphaned = await tx
    .select({ spaceId: spacePackages.spaceId })
    .from(spacePackages)
    .innerJoin(spaces, eq(spaces.id, spacePackages.spaceId))
    .where(
      and(
        eq(spacePackages.packageId, packageId),
        eq(spaces.orgId, orgId),
        ne(spacePackages.spaceId, newHomeSpaceId),
      ),
    );

  if (orphaned.length > 0) {
    await tx
      .insert(packageShares)
      .values(orphaned.map((row) => ({ packageId, spaceId: row.spaceId, sharedBy: null })))
      .onConflictDoNothing();
  }

  await tx
    .delete(packageShares)
    .where(and(eq(packageShares.packageId, packageId), eq(packageShares.spaceId, newHomeSpaceId)));
}
