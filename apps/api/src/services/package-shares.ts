// SPDX-License-Identifier: Apache-2.0

/**
 * A package's AUDIENCE — which spaces it is offered to (`package_shares`,
 * RBAC spec §6.10).
 *
 * Sharing and activating are two acts on two tables. This module owns the
 * first: it writes, reads and revokes the offer. The second stays in
 * `space-packages.ts`, because a package runs with the RECIPIENT's credentials
 * and switching one on is therefore the recipient's own decision.
 *
 * The table is read as PLACEMENT, and it is read wherever the placement
 * question is asked: an offer is one half of `placementGrantsRead` (homed here
 * ∨ offered here), so every reader of that rule joins it — the EXECUTION
 * predicate included, which conjoins the placement filter so a `space_packages`
 * row with no placement behind it counts for nothing. The exact set of files
 * that name `packageShares`, and why each one does, is pinned by
 * `test/integration/routes/package-sharing.test.ts` ("the table has no other
 * reader"); that test is the authority, not a list in this comment.
 *
 * What a row here never is, on its own, is an authorization to RUN: it places
 * and it opens a read. Activation is a second act, on `space_packages`, and it
 * belongs to the recipient.
 */

import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import {
  organizationMembers,
  packageShares,
  packages,
  spacePackages,
  spaces,
  user,
} from "@appstrate/db/schema";
import { conflict, forbidden, notFound } from "../lib/errors.ts";

/**
 * The `user` row of the person who shared, joined ALONGSIDE the personal-space
 * owner's — two different people, one table, so the sharer needs an alias.
 */
const sharer = alias(user, "sharer");

/** One entry of `GET /api/packages/{scope}/{name}/shares`. */
export interface PackageShareView {
  /**
   * WHO the package is offered to. A personal space is rendered as its OWNER
   * and never as a space id: the sharer picked a person, the server resolved
   * their space, and handing that id back would publish the one thing §3.6
   * withholds — that a given id is somebody's private workspace.
   */
  target:
    | { kind: "user"; user_id: string; name: string }
    | { kind: "space"; space_id: string; name: string };
  shared_by: { user_id: string; name: string } | null;
  created_at: string;
}

/**
 * The sharer, as the WIRE names them. `null` once the account is gone — and
 * `null` too once they have left the ORGANIZATION: `shared_by` cascades to NULL
 * on account deletion but nothing clears it on a membership revocation, and
 * this view is read by everyone the package is visible to.
 */
function sharerView(row: {
  sharedBy: string | null;
  sharerName: string | null;
}): PackageShareView["shared_by"] {
  return row.sharedBy && row.sharerName ? { user_id: row.sharedBy, name: row.sharerName } : null;
}

/**
 * Offer `packageId` to `spaceId`. Idempotent — a second share of the same pair
 * is a no-op, and `created` says which happened so the caller can skip the
 * notification and the audit event on a repeat.
 *
 * The home is re-read `FOR SHARE` and BOTH refusals decided INSIDE the write's
 * transaction, the same discipline `activatePackageWithin` applies for the same
 * reason (`services/space-packages.ts`): `PUT /api/packages/{scope}/{name}/home`
 * rewrites `home_space_id` in a transaction of its own, so anything decided on
 * a row this call does not hold interleaves — the route reads home A, the move
 * commits home B, and the insert lands against a home nobody judged.
 *
 * TWO questions travel together, and the second is the load-bearing one.
 * `share_target_is_home` is the cheap invariant: an offer to the space the
 * package lives in. `authorizeHome` is the AUTHORITY — `<type>:share` in the
 * home — and it has to be re-asked here because the route asked it of home A
 * while this insert is judged against home B, where the caller may hold
 * nothing. Re-asking under the lock is what makes the answer true at COMMIT
 * rather than at request time; the `FOR SHARE` freezes the column, so the home
 * this reads is the home the row will have.
 *
 * @throws 403 when the caller holds no share authority in the LOCKED home; 409
 *   `share_target_is_home`; 404 if the package went away under the caller's
 *   feet (the FK would refuse the insert anyway, less legibly).
 */
export async function sharePackage(params: {
  packageId: string;
  spaceId: string;
  orgId: string;
  sharedBy: string;
  /**
   * "Does the caller still hold `<type>:share` in THIS home?" — the route's own
   * rule, handed in as a predicate so the service stays free of a Context while
   * the decision is made against the locked row rather than the read one.
   */
  authorizeHome: (homeSpaceId: string | null) => boolean;
}): Promise<{ created: boolean }> {
  const { packageId, spaceId, orgId, sharedBy, authorizeHome } = params;
  // The org boundary is asserted HERE, in the service, the same place {@link
  // revokePackageShare} asserts it and for the same reason: neither
  // `package_shares` nor the pair `(package_id, space_id)` carries an
  // `org_id`, so nothing below would stop a row naming another tenant's space.
  // `authorizeHome` refuses a foreign home already — it resolves against the
  // caller's own spaces — but that leaves the tenant check inside a callback
  // the service cannot see, which is the asymmetry that made one of two
  // sibling functions look accidental.
  //
  // It takes two statements where the revoke takes one clause, and the reason
  // is SQL rather than taste: a DELETE has a WHERE to hang `inArray(…, inOrg)`
  // on, an INSERT … VALUES has none. So the two ends are read explicitly
  // instead — the package below, under the lock it needs anyway, and the
  // target space here.
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId)))
      .limit(1);
    if (!target) throw notFound(`Space '${spaceId}' not found`);
    const [pkg] = await tx
      .select({ homeSpaceId: packages.homeSpaceId })
      .from(packages)
      .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
      .limit(1)
      .for("share");
    if (!pkg) throw notFound(`Package '${packageId}' not found in this organization`);
    // BEFORE the target check, because it is the stronger refusal: a caller who
    // no longer governs this package must not learn whether the space they
    // named happens to be its home.
    if (!authorizeHome(pkg.homeSpaceId)) {
      throw forbidden(
        `Sharing '${packageId}' requires the share permission in its home space — the package moved home while this request was in flight.`,
      );
    }
    if (pkg.homeSpaceId === spaceId) {
      throw conflict(
        "share_target_is_home",
        "This package already lives in that space — sharing it there would offer it to itself.",
      );
    }
    const inserted = await tx
      .insert(packageShares)
      .values({ packageId, spaceId, sharedBy })
      .onConflictDoNothing()
      .returning({ packageId: packageShares.packageId });
    return { created: inserted.length > 0 };
  });
}

/**
 * Withdraw the offer, and with it the placement it backs — in ONE transaction.
 * Leaving the `space_packages` row behind would keep the package running in a
 * space that is no longer allowed to see it, which is the whole failure mode
 * the two-table split exists to prevent. This is also the ONE path that deletes
 * a placement row: deactivating keeps it, settings and all.
 *
 * The offer goes FIRST, and that order is a contract rather than a preference:
 * `activatePackageWithin` locks the same two rows and takes `package_shares`
 * before `space_packages` for this reason. Two transactions taking one pair of
 * row locks in opposite orders deadlock — PostgreSQL aborts one with `40P01` —
 * and an activation racing a revoke is the ordinary case, not the exotic one.
 *
 * @returns `false` when there was no share row, which the route renders as 404.
 */
export async function revokePackageShare(params: {
  packageId: string;
  spaceId: string;
  orgId: string;
  /** The route's own rule, asked against the home this transaction holds — see {@link sharePackage}. */
  authorizeHome: (homeSpaceId: string | null) => boolean;
}): Promise<false | { placementRemoved: boolean }> {
  const { packageId, spaceId, orgId, authorizeHome } = params;
  // The org predicate lands in BOTH deletes' WHERE: neither table has an
  // `org_id`, so `(space_id, package_id)` alone would act on a row pointing at
  // a space this organization does not own. No such row can be written today;
  // the guard is what keeps that true.
  const inOrg = db.select({ id: spaces.id }).from(spaces).where(eq(spaces.orgId, orgId));
  return db.transaction(async (tx) => {
    // The authority, against the LOCKED home, for the reason `sharePackage`
    // states: the route judged the home as it stood when the request arrived,
    // and a `PUT …/{scope}/{name}/home` committing in between moves the package to
    // a home this caller may govern not at all. Withdrawing an audience is a
    // lighter act than granting one — it takes access away rather than handing
    // it out — but it is the SAME authority, and one of three home-dependent
    // mutations left asking it of a stale row is the inconsistency that makes
    // the other two look accidental.
    const [pkg] = await tx
      .select({ homeSpaceId: packages.homeSpaceId })
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1)
      .for("share");
    if (!pkg) throw notFound(`Package '${packageId}' not found in this organization`);
    if (!authorizeHome(pkg.homeSpaceId)) {
      throw forbidden(
        `Withdrawing an offer of '${packageId}' requires the share permission in its home space — the package moved home while this request was in flight.`,
      );
    }
    const removed = await tx
      .delete(packageShares)
      .where(
        and(
          eq(packageShares.packageId, packageId),
          eq(packageShares.spaceId, spaceId),
          inArray(packageShares.spaceId, inOrg),
        ),
      )
      .returning({ packageId: packageShares.packageId });
    if (removed.length === 0) return false as const;
    const placementRemoved = await tx
      .delete(spacePackages)
      .where(
        and(
          eq(spacePackages.packageId, packageId),
          eq(spacePackages.spaceId, spaceId),
          inArray(spacePackages.spaceId, inOrg),
        ),
      )
      .returning({ packageId: spacePackages.packageId });
    return { placementRemoved: placementRemoved.length > 0 };
  });
}

/**
 * Every space `packageId` is offered to, within `orgId`, rendered for the
 * sharer. Ordered by `created_at` so the listing is stable. `spaceId` narrows
 * it to one entry — what `POST …/shares` answers with, so the write and the
 * listing render a target through the same projection.
 */
export async function listPackageShares(
  packageId: string,
  orgId: string,
  spaceId?: string,
): Promise<PackageShareView[]> {
  const rows = await db
    .select({
      spaceId: packageShares.spaceId,
      spaceName: spaces.name,
      ownerUserId: spaces.ownerUserId,
      sharedBy: packageShares.sharedBy,
      createdAt: packageShares.createdAt,
      ownerName: user.name,
      sharerName: sharer.name,
    })
    .from(packageShares)
    .innerJoin(spaces, eq(spaces.id, packageShares.spaceId))
    .leftJoin(user, eq(user.id, spaces.ownerUserId))
    // The membership is the join, not a filter applied afterwards: the sharer's
    // name is loaded only for someone who is still in this organization.
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, packageShares.sharedBy),
        eq(organizationMembers.orgId, orgId),
      ),
    )
    .leftJoin(sharer, eq(sharer.id, organizationMembers.userId))
    .where(
      and(
        eq(packageShares.packageId, packageId),
        eq(spaces.orgId, orgId),
        spaceId ? eq(packageShares.spaceId, spaceId) : undefined,
      ),
    )
    .orderBy(packageShares.createdAt);

  return rows.map((row) => ({
    target: row.ownerUserId
      ? {
          kind: "user" as const,
          user_id: row.ownerUserId,
          name: row.ownerName ?? row.ownerUserId,
        }
      : { kind: "space" as const, space_id: row.spaceId, name: row.spaceName },
    shared_by: sharerView(row),
    created_at: row.createdAt.toISOString(),
  }));
}
