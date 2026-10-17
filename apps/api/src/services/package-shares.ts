// SPDX-License-Identifier: Apache-2.0

/**
 * A package's AUDIENCE — the spaces it is placed in outside its home
 * (RBAC spec §6.10).
 *
 * A placement is a `space_packages` row; this module places a package through
 * the one door that may (`placePackage`, `services/space-packages.ts`), lists
 * the placements outside the home, and withdraws one. A placement lands
 * switched on when the sharer may activate in the target, and off otherwise:
 * a package runs with the RECIPIENT's credentials, so switching it on there is
 * the recipient's own decision.
 */

import { and, eq, ne, or, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { organizationMembers, packages, spacePackages, spaces, user } from "@appstrate/db/schema";
import { forbidden, notFound } from "../lib/errors.ts";
import { loadPlaceablePackage, placePackage, type PlacementAuthority } from "./space-packages.ts";
import { withdrawPlacement } from "./package-placement.ts";
import type { PlacementRemovalAuthority } from "../lib/package-access.ts";

/**
 * The `user` row of the person who shared, joined ALONGSIDE the personal-space
 * owner's — two different people, one table, so the sharer needs an alias.
 */
const sharer = alias(user, "sharer");

/** One entry of `GET /api/packages/{scope}/{name}/shares`. */
export interface PackageShareView {
  /**
   * WHO the package is placed with. A personal space is rendered as its OWNER
   * and never as a space id: the sharer picked a person, the server resolved
   * their space, and handing that id back would publish the one thing §3.6
   * withholds — that a given id is somebody's private workspace.
   */
  target:
    | { kind: "user"; userId: string; name: string }
    | { kind: "space"; spaceId: string; name: string };
  /** `user_id`, not `userId`: one of the enumerated counter-exceptions of CASING_CONVENTIONS. */
  shared_by: { user_id: string; name: string } | null;
  /** `space_packages.enabled` of the target's row. */
  enabled: boolean;
  createdAt: string;
}

/**
 * The sharer, as the WIRE names them. `null` once the account is gone — and
 * `null` too once they have left the ORGANIZATION: `shared_by` cascades to NULL
 * on account deletion but nothing clears it on a membership revocation, and
 * this view is read by everyone the package is visible to.
 *
 * Exported because the space library projects the same placements
 * (`services/package-library.ts`) off its own `organizationMembers` join: two
 * copies of this ternary is two places for "a former member is never named" to
 * stop being true, and only one of them serves the page an owner reads.
 */
export function sharerView(row: {
  sharedBy: string | null;
  sharerName: string | null;
}): PackageShareView["shared_by"] {
  return row.sharedBy && row.sharerName ? { user_id: row.sharedBy, name: row.sharerName } : null;
}

/**
 * Place `packageId` in `spaceId`, outside its home. Idempotent — a second share
 * of the same pair is a no-op that leaves the existing row as it stands, and
 * `created` says which happened so the caller can skip the notification and
 * the audit event on a repeat.
 *
 * Every precondition is `placePackage`'s, decided against the home it reads
 * `FOR SHARE` in this transaction: `PUT …/home` rewrites `home_space_id` in a
 * transaction of its own, so the route can read home A while the insert lands
 * against home B. `enabled` is the route's answer to "may the caller activate
 * in the target?".
 *
 * @throws 403 when the caller holds no share authority in the LOCKED home; 409
 *   `share_target_is_home` or `package_has_no_version`; 404 if the target
 *   space is not this organization's or the package went away.
 */
export async function sharePackage(params: {
  packageId: string;
  spaceId: string;
  orgId: string;
  placeAs: PlacementAuthority;
  enabled: boolean;
}): Promise<{ created: boolean }> {
  const { packageId, spaceId, orgId, placeAs, enabled } = params;
  // The org boundary is asserted HERE, in the service, where {@link
  // revokePackageShare} asserts it too: `space_packages` carries no `org_id`,
  // so nothing below would stop a row naming another tenant's space.
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId)))
      .limit(1);
    if (!target) throw notFound(`Space '${spaceId}' not found`);
    const pkg = await loadPlaceablePackage(tx, { orgId, spaceId }, packageId);
    const row = await placePackage(tx, pkg, spaceId, { ...placeAs, enabled });
    return { created: row !== null };
  });
}

/**
 * Withdraw a placement outside the package's home — {@link withdrawPlacement}:
 * its `space_packages` row, settings and all, and the package's schedules in
 * that space, in one transaction. Deactivating deletes nothing: it keeps the
 * row. The other act that withdraws one is the `keep: false` branch of
 * `reconcilePlacementsAfterRehome` (`services/package-placement.ts`).
 *
 * @returns which side's authority withdrew it, and the disabled schedules,
 *   whose jobs the caller removes once committed.
 * @throws 404 when the space holds no placement outside the home this
 *   transaction holds, or is a personal space other than `personalOwnerId`'s;
 *   403 when `authorityFor` refuses against that home.
 */
export async function revokePackageShare(params: {
  packageId: string;
  spaceId: string;
  orgId: string;
  /**
   * The one personal space the withdrawal may name — the recipient's a `user`
   * target resolved to, else the caller's own. Somebody else's, named by id,
   * answers the 404 a missing row answers, so that id stays opaque (§3.6).
   */
  personalOwnerId: string | null;
  /** The route's rule (`assertPlacementRemovalAccess`), asked against the home this transaction holds. */
  authorityFor: (homeSpaceId: string | null) => PlacementRemovalAuthority | null;
}): Promise<{ authority: PlacementRemovalAuthority; disabledScheduleIds: string[] }> {
  const { packageId, spaceId, orgId, personalOwnerId, authorityFor } = params;
  const notPlaced = () => notFound(`Package '${packageId}' is not placed in that space`);
  return db.transaction(async (tx) => {
    // The authority, against the LOCKED home, for the reason `sharePackage`
    // states: a `PUT …/{scope}/{name}/home` committing between the route's
    // check and this delete moves the package to a home this caller may govern
    // not at all. The lock order is the doors' — `packages`, then the row.
    const [pkg] = await tx
      .select({ homeSpaceId: packages.homeSpaceId })
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1)
      .for("share");
    if (!pkg) throw notFound(`Package '${packageId}' not found in this organization`);
    const authority = authorityFor(pkg.homeSpaceId);
    if (!authority) {
      throw forbidden(
        `Withdrawing a placement of '${packageId}' requires the share permission in its home space — the package moved home while this request was in flight.`,
      );
    }
    if (pkg.homeSpaceId === spaceId) throw notPlaced();
    // The org boundary is asserted here: `space_packages` carries no `org_id`,
    // so `(space_id, package_id)` alone would act on a row pointing at a space
    // this organization does not own.
    const [target] = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.id, spaceId),
          eq(spaces.orgId, orgId),
          personalOwnerId === null
            ? isNull(spaces.ownerUserId)
            : or(isNull(spaces.ownerUserId), eq(spaces.ownerUserId, personalOwnerId)),
        ),
      )
      .limit(1);
    if (!target) throw notPlaced();
    const { removed, disabledScheduleIds } = await withdrawPlacement(tx, packageId, spaceId);
    // Thrown rather than returned so the schedules' disable rolls back with it:
    // a space that held no row had nothing withdrawn.
    if (!removed) throw notPlaced();
    return { authority, disabledScheduleIds };
  });
}

/**
 * Every space `packageId` is placed in within `orgId` outside its home,
 * rendered for the sharer. Ordered by `installed_at` so the listing is stable.
 * `spaceId` narrows it to one entry — what `POST …/shares` answers with, so the
 * write and the listing render a target through the same projection.
 */
export async function listPackageShares(
  packageId: string,
  orgId: string,
  spaceId?: string,
): Promise<PackageShareView[]> {
  const rows = await db
    .select({
      spaceId: spacePackages.spaceId,
      spaceName: spaces.name,
      ownerUserId: spaces.ownerUserId,
      sharedBy: spacePackages.sharedBy,
      createdAt: spacePackages.installedAt,
      enabled: spacePackages.enabled,
      ownerName: user.name,
      sharerName: sharer.name,
    })
    .from(spacePackages)
    .innerJoin(spaces, eq(spaces.id, spacePackages.spaceId))
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .leftJoin(user, eq(user.id, spaces.ownerUserId))
    // The membership is the join, not a filter applied afterwards: the sharer's
    // name is loaded only for someone who is still in this organization.
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, spacePackages.sharedBy),
        eq(organizationMembers.orgId, orgId),
      ),
    )
    .leftJoin(sharer, eq(sharer.id, organizationMembers.userId))
    .where(
      and(
        eq(spacePackages.packageId, packageId),
        eq(spaces.orgId, orgId),
        // A system package is never shared, and the home is not an audience.
        eq(packages.orgId, orgId),
        or(isNull(packages.homeSpaceId), ne(packages.homeSpaceId, spacePackages.spaceId)),
        spaceId ? eq(spacePackages.spaceId, spaceId) : undefined,
      ),
    )
    .orderBy(spacePackages.installedAt);

  return rows.map((row) => ({
    target: row.ownerUserId
      ? {
          kind: "user" as const,
          userId: row.ownerUserId,
          name: row.ownerName ?? row.ownerUserId,
        }
      : { kind: "space" as const, spaceId: row.spaceId, name: row.spaceName },
    shared_by: sharerView(row),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  }));
}
