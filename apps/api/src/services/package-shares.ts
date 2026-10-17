// SPDX-License-Identifier: Apache-2.0

/**
 * A package's audience: its placements outside its home (RBAC spec §6.10).
 * Places through `placePackage`, lists the placements, withdraws one.
 */

import { and, eq, ne, or, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { organizationMembers, packages, spacePackages, spaces, user } from "@appstrate/db/schema";
import { forbidden, notFound } from "../lib/errors.ts";
import { loadPlaceablePackage, placePackage, type PlacementAuthority } from "./space-packages.ts";
import { withdrawPlacement } from "./package-placement.ts";
import type { PlacementRemovalAuthority } from "../lib/package-access.ts";

/** Alias: the sharer and the personal-space owner are two `user` rows in one query. */
const sharer = alias(user, "sharer");

/** One entry of `GET /api/packages/{scope}/{name}/shares`. */
export interface PackageShareView {
  /** A personal space is rendered as its owner, never as a space id (§3.6). */
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
 * The sharer as the wire names them; `null` once the account is gone or the
 * sharer left the organization (a membership revocation does not clear
 * `shared_by`). Shared with `package-library.ts`.
 */
export function sharerView(row: {
  sharedBy: string | null;
  sharerName: string | null;
}): PackageShareView["shared_by"] {
  return row.sharedBy && row.sharerName ? { user_id: row.sharedBy, name: row.sharerName } : null;
}

/**
 * Place `packageId` in `spaceId`, outside its home. Idempotent: a repeat leaves
 * the row as is and returns `created: false`. Preconditions are `placePackage`'s,
 * decided against the home it locks. `enabled` is the route's answer to "may the
 * caller activate in the target?".
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
  // `space_packages` has no `org_id`: the org boundary is asserted here.
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
 * Withdraw a placement outside the home ({@link withdrawPlacement}).
 *
 * @returns the authority that withdrew it and the disabled schedules, whose
 *   jobs the caller removes once committed.
 * @throws 404 when the space holds no such placement or is a personal space
 *   other than `personalOwnerId`'s; 403 when `authorityFor` refuses.
 */
export async function revokePackageShare(params: {
  packageId: string;
  spaceId: string;
  orgId: string;
  /** The one personal space the withdrawal may name; any other answers 404 (§3.6). */
  personalOwnerId: string | null;
  /** The route's rule, asked against the locked home. */
  authorityFor: (homeSpaceId: string | null) => PlacementRemovalAuthority | null;
}): Promise<{ authority: PlacementRemovalAuthority; disabledScheduleIds: string[] }> {
  const { packageId, spaceId, orgId, personalOwnerId, authorityFor } = params;
  const notPlaced = () => notFound(`Package '${packageId}' is not placed in that space`);
  return db.transaction(async (tx) => {
    // Authority is judged against the locked home: a concurrent re-home
    // between the route's check and this delete must not slip through.
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
    // Org boundary (`space_packages` has no `org_id`).
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
    // Thrown so the schedules' disable rolls back too.
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
    // Membership is the join so a former member's name is never loaded.
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
