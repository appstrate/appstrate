// SPDX-License-Identifier: Apache-2.0

/**
 * WHERE a package is — PLACEMENT, the axis that is neither authority (who may
 * write it) nor activation (does this space run it).
 *
 * Two placements and no third (RBAC spec §6.9, §6.10): a package is placed in
 * the space that HOMES it and in every space it is SHARED with, plus — by
 * construction — in every space of every organization when the deployment
 * ships it. This module states that rule in SQL ({@link placementReadFilter}),
 * owns the two ON clauses the rule is read through, and owns the ONE act that
 * has to repair it ({@link reconcilePlacementsAfterRehome}).
 *
 * It is a leaf on purpose: the readers all import from here and nothing here
 * imports from them, which is what keeps the rule single-voiced.
 */

import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { packages, packageShares, spacePackages, spaces } from "@appstrate/db/schema";
import type { DbOrTx } from "../lib/db-helpers.ts";

/**
 * Drizzle filter: is the package PLACED in `spaceId`?
 *
 * Homed here, offered here, or shipped with the deployment — three disjuncts,
 * each a read grant on its own. The HOME grants read so that write authority
 * never exceeds read access (a builder able to `PUT` a package they cannot
 * `GET`), and so an author keeps sight of a draft nobody has been offered yet.
 * The OFFER grants read BEFORE anything is switched on, since the recipient
 * has to see a package's name and description to decide whether to activate it.
 *
 * A PLACEMENT ROW (`space_packages`) is deliberately not a fourth. It is the
 * only candidate that would answer "why does this space see this package"
 * without consulting `<type>:share`: a builder of B who reads A's package
 * anywhere could switch it on in B and hand B a placement A granted to nobody.
 * A row is a placement's consequence, never its source — which is why
 * `activeHereSql` conjoins THIS filter rather than trusting the row alone.
 *
 * Reads its share half off a LEFT JOIN of `packageShares`, whose ON clause is
 * {@link placementShareJoin}. The org boundary (`orgOrSystemFilter`) and the
 * shadow filter (`notEphemeralFilter`) are the caller's, as everywhere else.
 */
export function placementReadFilter(spaceId: string) {
  return or(
    eq(packages.source, "system"),
    isNotNull(packageShares.packageId),
    eq(packages.homeSpaceId, spaceId),
  );
}

/**
 * The ON clause every reader of {@link placementReadFilter} joins
 * `packageShares` with — `(this package, THIS space)`.
 *
 * The narrowing is the whole function, because getting it wrong fails QUIETLY.
 * Omitting the join raises a Postgres `missing FROM-clause entry`: loud,
 * immediate, impossible to ship. Joining on the PACKAGE ALONE raises nothing —
 * the filter then reads `package_shares.package_id IS NOT NULL` against a row
 * matched in ANY space, so "offered to THIS space" becomes "offered to any
 * space at all" and every reader of the rule widens at once. Taking `spaceId`
 * as a required argument leaves that mistake nowhere to live.
 *
 * `packageIdColumn` is the left-hand side because the readers join from two
 * different tables — `packages.id` on the catalogue reads, and
 * `spacePackages.packageId` on the ones that start from the placement row.
 */
export function placementShareJoin(packageIdColumn: AnyPgColumn, spaceId: string) {
  return and(eq(packageShares.packageId, packageIdColumn), eq(packageShares.spaceId, spaceId));
}

/**
 * The twin ON clause, for `spacePackages` — `(this package, THIS space)`.
 *
 * A placement ROW is deliberately NOT a placement ({@link placementReadFilter}
 * above), so this join does not answer "is it placed here". It is the other
 * half of the pair every placement-aware query carries: `activeHereSql`
 * (`services/package-activation.ts`) reads the space's decision off it, and the
 * listings project `enabled` and the per-space overrides from the same row.
 *
 * It is owned here for the reason {@link placementShareJoin} is, and the two
 * live side by side so the symmetry is visible: the space narrowing is what
 * makes either join answer for THIS space, and dropping it fails the same
 * quiet, open way. Without it `spacePackages.packageId IS NOT NULL` matches a
 * row another space wrote, so `activeHereSql` reads that space's `enabled` —
 * and a listing projects its model and proxy overrides.
 *
 * `packageIdColumn` for the same reason: the readers join from `packages.id`
 * and from `spacePackages.packageId` alike.
 */
export function placementRowJoin(packageIdColumn: AnyPgColumn, spaceId: string) {
  return and(eq(spacePackages.packageId, packageIdColumn), eq(spacePackages.spaceId, spaceId));
}

/**
 * Is the package placed in ANY space of the organization other than
 * `exceptSpaceId`? — the rule above, asked as an existence question.
 *
 * The caller is the offboarding sweeper (`emptyAndDeletePersonalSpace`,
 * `services/spaces.ts`), deciding whether a package homed in a departing
 * member's personal space is re-homed or deleted. `exceptSpaceId` is that
 * space: its home placement is the one leaving, so neither it nor a row or
 * offer sitting in it may answer for itself.
 *
 * Both tables are asked, because both place — and the row half is asked rather
 * than inferred from the offer half because of the orphans
 * `scripts/migration/0016` repairs. It lives HERE so that "placed elsewhere"
 * is not a second reading of placement owned by the sweeper.
 *
 * The org boundary is the caller's: no live path writes a row pointing at
 * another organization's space ({@link reconcilePlacementsAfterRehome} joins
 * `spaces` for exactly that), and an inherited one would answer "placed" and
 * get the package re-homed rather than deleted — the conservative direction.
 */
export async function isPlacedElsewhere(
  tx: DbOrTx,
  params: { packageId: string; exceptSpaceId: string },
): Promise<boolean> {
  const { packageId, exceptSpaceId } = params;
  const [row] = await tx
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), ne(spacePackages.spaceId, exceptSpaceId)),
    )
    .leftJoin(
      packageShares,
      and(eq(packageShares.packageId, packages.id), ne(packageShares.spaceId, exceptSpaceId)),
    )
    .where(
      and(
        eq(packages.id, packageId),
        or(isNotNull(spacePackages.spaceId), isNotNull(packageShares.spaceId)),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Re-home a package and leave no placement behind — the ONE reconciliation,
 * called by everything that rewrites `packages.home_space_id`.
 *
 * Moving the home OUT of a space that still holds a `space_packages` row would
 * leave a placement nothing places: invisible on every page of the space that
 * runs it, absent from its own index, and still firing from a cron if the doors
 * did not ask. That is the state `scripts/migration/0016` repairs on inherited
 * data, and no live code path may create another one.
 *
 * So every space of the organization holding a row, other than the NEW home,
 * gets the share that now places it — `shared_by` NULL, because nobody offered
 * it; the home did, until this call. The destination's own share is dropped for
 * the mirror-image reason `POST …/shares` answers `share_target_is_home`: a
 * package is not offered to the space it lives in. The only space whose answer
 * is a CHOICE is the home being left (`previousHome` below).
 *
 * Two callers: `PUT /api/packages/{scope}/{name}/home` moves a home
 * deliberately, and `emptyAndDeletePersonalSpace` (`services/spaces.ts`) moves
 * one because the author left, re-homing to the organization's DEFAULT space.
 *
 * Runs INSIDE the caller's transaction, always: the move and the placements it
 * invalidates commit together or not at all. Call it AFTER the
 * `packages.home_space_id` write, so a concurrent activation that waits on
 * that row's lock re-reads the home it will actually be judged against.
 */
export async function reconcilePlacementsAfterRehome(
  tx: DbOrTx,
  params: {
    packageId: string;
    orgId: string;
    newHomeSpaceId: string;
    /**
     * The home being LEFT, and what becomes of its placement — the one space
     * whose answer is a choice rather than an invariant.
     *
     * Every OTHER space holding a row already holds an offer, so the backfill
     * only ever creates one row: the old home's, which until this call was
     * placed by the home column itself. `PUT …/home` passes a human's answer
     * for it.
     *
     * `keep: true` backfills that space only when it holds a placement ROW.
     * The asymmetry is deliberate: the backfill exists to keep RUNNING what was
     * running, so a space that had switched the package off has nothing to
     * rescue, and writing it an offer anyway would WIDEN what it sees on an act
     * nobody asked to widen anything.
     *
     * `keep: false` withdraws the offer AND the placement row together — the
     * pair {@link revokePackageShare} withdraws — because dropping only the
     * offer leaves the ORPHAN this module exists to keep out of the database,
     * with the space's model, proxy and input values still on it.
     *
     * OMITTED by the personal-space sweeper, which re-homes on nobody's request
     * and so has no answer to give: every space that was running the package
     * goes on running it.
     */
    previousHome?: { spaceId: string; keep: boolean };
  },
): Promise<void> {
  const { packageId, orgId, newHomeSpaceId, previousHome } = params;
  const releasing =
    previousHome && !previousHome.keep && previousHome.spaceId !== newHomeSpaceId
      ? previousHome.spaceId
      : null;

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
        // A released old home is not backfilled — it is emptied below.
        releasing ? ne(spacePackages.spaceId, releasing) : undefined,
      ),
    );

  if (orphaned.length > 0) {
    await tx
      .insert(packageShares)
      .values(orphaned.map((row) => ({ packageId, spaceId: row.spaceId, sharedBy: null })))
      .onConflictDoNothing();
  }

  // Both halves, together: an offer withdrawn while its row stands is the
  // orphan this function exists to prevent.
  if (releasing) {
    await tx
      .delete(packageShares)
      .where(and(eq(packageShares.packageId, packageId), eq(packageShares.spaceId, releasing)));
    await tx
      .delete(spacePackages)
      .where(and(eq(spacePackages.packageId, packageId), eq(spacePackages.spaceId, releasing)));
  }

  await tx
    .delete(packageShares)
    .where(and(eq(packageShares.packageId, packageId), eq(packageShares.spaceId, newHomeSpaceId)));
}
