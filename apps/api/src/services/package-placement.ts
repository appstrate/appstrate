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
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
 * Reads its share half off a LEFT JOIN of `packageShares`, which
 * {@link placementShareJoin} owns — pass that as the join's ON clause and the
 * two cannot disagree. The org boundary (`orgOrSystemFilter`) and the shadow
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
 * The ON clause every reader of {@link placementReadFilter} joins
 * `packageShares` with — `(this package, THIS space)`.
 *
 * It exists because the two halves of that rule used to be written in two
 * different places: the filter here, and the join hand-copied into each of the
 * queries that use it. Getting the join wrong does not fail the way the pair
 * was documented to, and the difference is the whole reason this function
 * exists — both halves were measured:
 *
 *   - OMITTING the join entirely raises a Postgres `missing FROM-clause entry`.
 *     Loud, immediate, impossible to ship.
 *   - JOINING ON THE PACKAGE ALONE — `eq(packageShares.packageId, …)` without
 *     the space — raises NOTHING. The filter then reads
 *     `package_shares.package_id IS NOT NULL` against a row matched in ANY
 *     space, so "offered to THIS space" silently becomes "offered to any space
 *     at all", and every caller of the rule widens at once.
 *
 * So the dangerous half is the quiet one, and it fails OPEN. Taking `spaceId`
 * as a required argument is what removes it: the narrowing cannot be forgotten
 * because there is nowhere to forget it.
 *
 * `packageIdColumn` is the left-hand side because the readers join from two
 * different tables — `packages.id` on the catalogue reads, and
 * `spacePackages.packageId` on the ones that start from the placement row.
 */
export function placementShareJoin(packageIdColumn: AnyPgColumn, spaceId: string) {
  return and(eq(packageShares.packageId, packageIdColumn), eq(packageShares.spaceId, spaceId));
}

/**
 * Is the package placed in ANY space of the organization other than
 * `exceptSpaceId`? — the rule above, asked as an existence question.
 *
 * The one caller is the offboarding sweeper (`emptyAndDeletePersonalSpace`,
 * `services/spaces.ts`), deciding whether a package homed in a departing
 * member's personal space is re-homed or deleted, and `exceptSpaceId` is that
 * space: its home placement is the one leaving, so it must not answer for
 * itself, and neither may a row or an offer sitting in it.
 *
 * Both tables, because both place. An offer does it on its own — a space that
 * was SHOWN a package can see it, so the package was never private — and a
 * `space_packages` row does it through the offer behind it, except for the
 * orphans `scripts/migration/0016` repairs, which is why the row half is asked
 * rather than inferred from the offer half.
 *
 * It lives HERE and not in the sweeper for the reason the whole module exists:
 * "present elsewhere" answered anywhere else would be a second reading of
 * placement, and the sweeper would be the one path in the platform that owns
 * one. The LEFT JOIN shape is `isPackageReadableInSpace`'s and
 * `activeHereSql`'s, so it is one round trip.
 *
 * The org boundary is the caller's: the sweeper reads packages of one
 * organization, and a `space_packages` or `package_shares` row pointing at
 * another organization's space cannot be written by any live path
 * ({@link reconcilePlacementsAfterRehome} joins `spaces` for exactly that).
 * Were one to exist, it would answer "placed" and the package would be
 * re-homed rather than deleted — the conservative direction.
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
 * The one space whose answer is a CHOICE rather than an invariant is the home
 * being left: see `previousHome` below. Everything else here is forced.
 *
 * Two callers, one shape, and the second is why this is a function rather than
 * a paragraph inside the first: `PUT /api/packages/{scope}/{name}/home` moves a
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
  params: {
    packageId: string;
    orgId: string;
    newHomeSpaceId: string;
    /**
     * The home being LEFT, and what becomes of its placement — the one space
     * whose answer is a choice rather than an invariant.
     *
     * Every OTHER space holding a row already holds an offer (that offer is
     * what places it), so the backfill below only ever creates one row: the
     * old home's, which until this call was placed by the home column itself.
     * That is exactly the row a human is entitled to decide about, and
     * `PUT /api/packages/{scope}/{name}/home` passes their answer here.
     *
     * `keep: true` is the behaviour this function has always had, unchanged:
     * the backfill above covers the old home when it holds a placement ROW,
     * and leaves it out when it does not. That asymmetry is deliberate rather
     * than tidy — the backfill exists to keep RUNNING what was running, so a
     * space that had switched the package off has nothing to rescue, and
     * writing it an offer anyway would WIDEN what that space sees on an act
     * nobody asked to widen anything. Making the two cases uniform was tried
     * and reverted for exactly that reason.
     *
     * `keep: false` withdraws the offer AND the placement row together, the
     * pair {@link revokePackageShare} withdraws, because dropping only the
     * offer would leave a row nothing places — the ORPHAN this module exists
     * to keep out of the database, the residue `scripts/migration/0016`
     * repairs, and a state `activeHereSql` refuses to honour while the row
     * goes on carrying the space's model, proxy and stored input values.
     *
     * OMITTED by the personal-space sweeper, and that is the point of it being
     * optional: the sweeper re-homes a departed author's package on nobody's
     * request, so it has no answer to give and must keep the old behaviour —
     * every space that was running the package goes on running it.
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
