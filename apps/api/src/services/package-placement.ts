// SPDX-License-Identifier: Apache-2.0

/**
 * WHERE a package is — PLACEMENT, the axis that is neither authority (who may
 * write it) nor activation (does this space run it).
 *
 * Two placements and no third (RBAC spec §6.9, §6.10): a package is placed in
 * the space that HOMES it and in every space it is SHARED with, plus — by
 * construction — in every space of every organization when the deployment
 * ships it. This module states that rule in SQL ({@link placementReadFilter}),
 * owns the two ON clauses it is read through, and owns the ONE act that has to
 * repair it ({@link reconcilePlacementsAfterRehome}).
 */

import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { packages, packageShares, spacePackages, spaces } from "@appstrate/db/schema";
import type { DbOrTx } from "../lib/db-helpers.ts";

/**
 * Drizzle filter: is the package PLACED in `spaceId`? — homed here, offered
 * here, or shipped with the deployment, each a read grant on its own.
 *
 * A `space_packages` row is NOT a fourth disjunct: a row is a placement's
 * consequence, never its source, so `activeHereSql` conjoins this filter rather
 * than trusting the row alone. Without that, a builder of B who can read A's
 * package could switch it on in B and give B a placement A granted to nobody.
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
 * The space narrowing is the whole function. Dropping it widens "offered to
 * THIS space" into "offered to any space at all", in every reader at once, and
 * raises nothing — so `spaceId` is a required argument and
 * `package-placement-parity.test.ts` pins the widening with a package offered
 * elsewhere. (Dropping the JOIN instead is loud: Postgres 42P01.)
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
 * A row is not a placement, so this join does not answer "is it placed here".
 * It is the other half of the pair every placement-aware query carries:
 * `activeHereSql` (`services/package-activation.ts`) reads the space's decision
 * off it, and the listings project `enabled` and the per-space overrides.
 *
 * Owned here, and narrowed on the space, for the reason
 * {@link placementShareJoin} is — drop that narrowing and `activeHereSql` reads
 * another space's `enabled` while a listing projects its model and proxy
 * overrides, silently.
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
 * Both tables are asked: the row half cannot be inferred from the offer half
 * while the orphans `scripts/migration/0016` repairs still exist.
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
 * Moving the home OUT of a space that still holds a `space_packages` row leaves
 * a placement nothing places: invisible on every page of the space that runs
 * it, absent from its own index, and still firing from a cron. That is the
 * state `scripts/migration/0016` repairs on inherited data, and no live code
 * path may create another one.
 *
 * So every space of the organization holding a row, other than the NEW home,
 * gets the share that now places it — `shared_by` NULL, because the home placed
 * it until this call and no person offered it — and so does the home being
 * left, when it keeps the package, row or no row. The destination's own share is
 * dropped: a package is not offered to the space it lives in, the same rule
 * `POST …/shares` states as `share_target_is_home`. The only space whose answer
 * is a CHOICE is the home being left (`previousHome` below).
 *
 * Two callers: `PUT /api/packages/{scope}/{name}/home` moves a home
 * deliberately, and `emptyAndDeletePersonalSpace` (`services/spaces.ts`) moves
 * one because the author left, re-homing to the organization's DEFAULT space.
 *
 * Runs INSIDE the caller's transaction: the move and the placements it
 * invalidates commit together or not at all. Call it AFTER the
 * `packages.home_space_id` write, so a concurrent activation waiting on that
 * row's lock re-reads the home it will be judged against.
 */
export async function reconcilePlacementsAfterRehome(
  tx: DbOrTx,
  params: {
    packageId: string;
    orgId: string;
    newHomeSpaceId: string;
    /**
     * The home being LEFT, and what becomes of its placement — the one space
     * whose answer is a choice rather than an invariant. `PUT …/home` passes a
     * human's answer for it.
     *
     * `keep: true` backfills that space UNCONDITIONALLY — whether or not it
     * holds a placement row. The offer restores the READ placement the home was
     * providing until this call, and that is the whole promise `PUT …/home`
     * makes: the move answers the same way whether or not the old home happened
     * to have activated the package. Conditioning it on a row would break that
     * promise in exactly the case nobody can see — a package created in a space
     * whose first version never published, and which therefore never got a row
     * — leaving it neither homed nor offered anywhere, invisible to the space
     * that authored it. It widens nothing: the row (absent, or present and
     * `enabled = false`) still decides on its own what the space RUNS.
     *
     * `keep: false` withdraws the offer AND the placement row together — the
     * pair {@link revokePackageShare} withdraws — since dropping only the offer
     * leaves an orphan carrying the space's model, proxy and input values.
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
  const keeping =
    previousHome && previousHome.keep && previousHome.spaceId !== newHomeSpaceId
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

  // One element more, not one query more: the old home that KEEPS the package
  // is backfilled whether or not the SELECT above found a row for it, because
  // its placement came from the home column this call just rewrote and not from
  // a row. It needs no `spaces` join to clear the org boundary — it IS the
  // package's previous home, so it belongs to the package's organization by the
  // same constraint that put it there. `onConflictDoNothing` makes the addition
  // idempotent when the row was already in `orphaned`.
  const backfill = new Set(orphaned.map((row) => row.spaceId));
  if (keeping) backfill.add(keeping);

  if (backfill.size > 0) {
    await tx
      .insert(packageShares)
      .values([...backfill].map((spaceId) => ({ packageId, spaceId, sharedBy: null })))
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
