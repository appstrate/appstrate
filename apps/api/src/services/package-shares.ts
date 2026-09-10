// SPDX-License-Identifier: Apache-2.0

/**
 * A package's AUDIENCE — which spaces it is offered to (`package_shares`,
 * RBAC spec §6.10).
 *
 * Sharing and installing are two acts on two tables. This module owns the
 * first: it writes, reads and revokes the offer. The second stays in
 * `space-packages.ts`, because a package runs with the RECIPIENT's credentials
 * and activating one is therefore the recipient's own decision.
 *
 * `package_shares` has exactly four readers in the codebase, and they are all
 * READS: this module, `placementGrantsRead`'s loaders (`lib/package-access.ts`),
 * the per-type index listing (`package-items/crud.ts`) and the install path
 * (`space-packages.ts`), which asks whether an offer exists inside the very
 * transaction that acts on it. Nothing on an execution path consults it.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { packageShares, spacePackages, spaces, user } from "@appstrate/db/schema";

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

/** The sharer, as every share projection names them. `null` once the account is gone. */
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
 */
export async function sharePackage(params: {
  packageId: string;
  spaceId: string;
  sharedBy: string;
}): Promise<{ created: boolean }> {
  const inserted = await db
    .insert(packageShares)
    .values(params)
    .onConflictDoNothing()
    .returning({ packageId: packageShares.packageId });
  return { created: inserted.length > 0 };
}

/**
 * Withdraw the offer, and with it the installation it backs — in ONE
 * transaction (plan decision 3). Leaving the `space_packages` row behind would
 * keep the package running in a space that is no longer allowed to see it,
 * which is the whole failure mode the two-table split exists to prevent.
 *
 * @returns `false` when there was no share row, which the route renders as 404.
 */
export async function revokePackageShare(params: {
  packageId: string;
  spaceId: string;
  orgId: string;
}): Promise<false | { uninstalled: boolean }> {
  const { packageId, spaceId, orgId } = params;
  // The org predicate lands in BOTH deletes' WHERE, the way `uninstallPackage`
  // carries it: neither table has an `org_id`, so `(space_id, package_id)`
  // alone would act on a row pointing at a space this organization does not
  // own. No such row can be written today; the guard is what keeps that true.
  const inOrg = db.select({ id: spaces.id }).from(spaces).where(eq(spaces.orgId, orgId));
  return db.transaction(async (tx) => {
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
    const uninstalled = await tx
      .delete(spacePackages)
      .where(
        and(
          eq(spacePackages.packageId, packageId),
          eq(spacePackages.spaceId, spaceId),
          inArray(spacePackages.spaceId, inOrg),
        ),
      )
      .returning({ packageId: spacePackages.packageId });
    return { uninstalled: uninstalled.length > 0 };
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
    .leftJoin(sharer, eq(sharer.id, packageShares.sharedBy))
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

/** One row of the library's `shared` section. */
export interface SharedPackageRow {
  packageId: string;
  spaceId: string;
  shared_by: { user_id: string; name: string } | null;
}

/**
 * Packages offered to one of `spaceIds` and NOT installed there — the library's
 * "Shared with me" section, i.e. exactly the offers still waiting on a
 * decision. An accepted share leaves this list and appears as an installation.
 */
export async function listSharedNotInstalled(
  spaceIds: readonly string[],
): Promise<SharedPackageRow[]> {
  if (spaceIds.length === 0) return [];
  const rows = await db
    .select({
      packageId: packageShares.packageId,
      spaceId: packageShares.spaceId,
      sharedBy: packageShares.sharedBy,
      sharerName: user.name,
    })
    .from(packageShares)
    .leftJoin(
      spacePackages,
      and(
        eq(spacePackages.packageId, packageShares.packageId),
        eq(spacePackages.spaceId, packageShares.spaceId),
      ),
    )
    .leftJoin(user, eq(user.id, packageShares.sharedBy))
    .where(and(inArray(packageShares.spaceId, [...spaceIds]), isNull(spacePackages.packageId)));
  return rows.map((row) => ({
    packageId: row.packageId,
    spaceId: row.spaceId,
    shared_by: sharerView(row),
  }));
}
