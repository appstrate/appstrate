// SPDX-License-Identifier: Apache-2.0

/**
 * PLACEMENT: where a package is, distinct from authority and activation
 * (RBAC spec §6.9, §6.10). Placed = homed here, holding a `space_packages` row
 * here, shipped with the deployment, or offered to the space's organization.
 */

import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { orgPackageOffers, packages, schedules, spacePackages, spaces } from "@appstrate/db/schema";
import type { OrgOfferMode } from "@appstrate/db/schema";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import { disableSchedules } from "./schedules-naming-connection.ts";

const offerSpace = alias(spaces, "offer_space");

/**
 * Drizzle filter: is the outer `packages` row offered to the organization `orgId`
 * (`org_package_offers`), in `mode` when given, in either mode otherwise? A
 * correlated EXISTS, so no call site joins anything. `orgId` is a value, or a
 * subquery of the outer query.
 */
function offeredToOrgSql(orgId: string | SQLWrapper, mode?: OrgOfferMode) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(orgPackageOffers)
      .where(
        and(
          eq(orgPackageOffers.orgId, orgId),
          eq(orgPackageOffers.packageId, packages.id),
          mode ? eq(orgPackageOffers.mode, mode) : undefined,
        ),
      ),
  );
}

/**
 * {@link offeredToOrgSql} for the organization of `spaceId`, a value or a column of the outer
 * query. Without `mode` it is the PLACEMENT question (offered in any mode); with one, the
 * ACTIVATION question (`on_by_default`).
 */
export function offeredToSpaceOrgSql(spaceId: string | AnyPgColumn, mode?: OrgOfferMode) {
  return offeredToOrgSql(
    db.select({ orgId: offerSpace.orgId }).from(offerSpace).where(eq(offerSpace.id, spaceId)),
    mode,
  );
}

/** The packages offered to `orgId` with the mode of each offer, narrowed to `packageIds` when given. */
export async function listOrgOffers(
  orgId: string,
  packageIds?: readonly string[],
  executor: DbOrTx = db,
): Promise<Map<string, OrgOfferMode>> {
  if (packageIds?.length === 0) return new Map();
  const rows = await executor
    .select({ packageId: orgPackageOffers.packageId, mode: orgPackageOffers.mode })
    .from(orgPackageOffers)
    .where(
      and(
        eq(orgPackageOffers.orgId, orgId),
        packageIds ? inArray(orgPackageOffers.packageId, [...packageIds]) : undefined,
      ),
    );
  return new Map(rows.map((row) => [row.packageId, row.mode]));
}

/** The subset of `packageIds` offered to the organization of `spaceId`, with each offer's mode: the in-memory twin's input. */
export async function listOfferedToSpaceOrg(
  spaceId: string,
  packageIds: readonly string[],
  executor: DbOrTx = db,
): Promise<Map<string, OrgOfferMode>> {
  const [space] = await executor
    .select({ orgId: spaces.orgId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  return space ? listOrgOffers(space.orgId, packageIds, executor) : new Map();
}

/**
 * The spaces of `orgId` the package is placed in beyond its home and the
 * deployment: every space when it is offered to the organization, else those
 * holding a row.
 */
export async function placedSpaceIds(
  orgId: string,
  packageId: string,
  executor: DbOrTx = db,
): Promise<string[]> {
  if ((await listOrgOffers(orgId, [packageId], executor)).has(packageId)) {
    const all = await executor
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.orgId, orgId));
    return all.map((row) => row.id);
  }
  const rows = await executor
    .select({ id: spacePackages.spaceId })
    .from(spacePackages)
    .innerJoin(spaces, eq(spaces.id, spacePackages.spaceId))
    .where(and(eq(spacePackages.packageId, packageId), eq(spaces.orgId, orgId)));
  return rows.map((row) => row.id);
}

/**
 * Drizzle filter: is the package placed in `spaceId`? Needs a LEFT JOIN of
 * `spacePackages` on {@link placementRowJoin}; org and shadow filters are the caller's.
 */
export function placementReadFilter(spaceId: string | AnyPgColumn) {
  return or(
    eq(packages.source, "system"),
    isNotNull(spacePackages.packageId),
    eq(packages.homeSpaceId, spaceId),
    offeredToSpaceOrgSql(spaceId),
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
 * An offer to the organization places it in every space, so it counts: deleting
 * a package the whole organization runs would be worse than re-homing it. The
 * org boundary is the caller's.
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
  if (row) return true;
  const offered = await listOfferedToSpaceOrg(exceptSpaceId, [packageId], tx);
  return offered.has(packageId);
}

/**
 * What a home move (`PUT …/home`) does to the placement it leaves; only the
 * home being left is a choice. Runs inside the caller's transaction.
 *
 * @returns `kept`: the previous home keeps a placement row of its own, decided here (false when
 *   `keep` is false, the home is a personal space, it held no row, or it is the new home); and the
 *   schedules {@link withdrawPlacement} disabled, whose jobs the caller removes once committed.
 */
export async function reconcilePlacementsAfterRehome(
  tx: Tx,
  params: {
    packageId: string;
    newHomeSpaceId: string;
    /**
     * The home being left. `keep: true` keeps its row; `keep: false` withdraws
     * it. A space with no row is withdrawn either way (its schedules go off), and
     * so is a personal space: outside its home it takes the offer only.
     */
    previousHome: { spaceId: string; keep: boolean };
  },
): Promise<{ kept: boolean; disabledScheduleIds: string[] }> {
  const { packageId, newHomeSpaceId, previousHome } = params;
  // A row in the home is never an offer row: it is the home's own, whatever it was before the move.
  await tx
    .update(spacePackages)
    .set({ placedByOffer: false })
    .where(and(eq(spacePackages.packageId, packageId), eq(spacePackages.spaceId, newHomeSpaceId)));
  if (previousHome.spaceId === newHomeSpaceId) return { kept: false, disabledScheduleIds: [] };
  if (previousHome.keep && !(await isPersonalSpace(tx, previousHome.spaceId))) {
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
    if (row) return { kept: true, disabledScheduleIds: [] };
  }
  const { disabledScheduleIds } = await withdrawPlacement(tx, packageId, previousHome.spaceId);
  return { kept: false, disabledScheduleIds };
}

/** Is `spaceId` a personal space (`spaces.owner_user_id` set)? Read inside the caller's transaction. */
export async function isPersonalSpace(tx: Tx, spaceId: string): Promise<boolean> {
  const [row] = await tx
    .select({ ownerUserId: spaces.ownerUserId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  return row?.ownerUserId != null;
}

/**
 * Disable, with `package_removed`, every armed schedule matching `where`,
 * locking them first. The one place a placement loss turns schedules off.
 *
 * @returns the disabled schedule ids, whose jobs the caller removes once committed.
 */
export async function disableArmedSchedules(tx: Tx, where: SQL | undefined): Promise<string[]> {
  const armed = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(where, eq(schedules.enabled, true)))
    .orderBy(asc(schedules.id))
    .for("update");
  const ids = armed.map((row) => row.id);
  await disableSchedules(tx, ids, "package_removed");
  return ids;
}

/**
 * Withdraw `packageId` from `spaceId`: the one delete of a `space_packages` row
 * (settings included). Every schedule of the package there is disabled with
 * `package_removed` in the same transaction; re-placing does not re-arm them.
 *
 * A package still offered to the space's organization stays placed and active
 * there with no row, so the row is not deleted but turned into a decision about
 * the offer (`placed_by_offer`, `enabled` and settings kept, a sticky opt-out
 * included) and the schedules are left armed. A row that already was one is no
 * placement to withdraw. The org boundary is the caller's.
 *
 * @returns whether a placement went, and the disabled schedules, whose jobs the
 *   caller removes once committed.
 */
export async function withdrawPlacement(
  tx: Tx,
  packageId: string,
  spaceId: string,
): Promise<{ removed: boolean; disabledScheduleIds: string[] }> {
  const here = and(eq(spacePackages.packageId, packageId), eq(spacePackages.spaceId, spaceId));
  if ((await listOfferedToSpaceOrg(spaceId, [packageId], tx)).has(packageId)) {
    const kept = await tx
      .update(spacePackages)
      .set({ placedByOffer: true, sharedBy: null })
      .where(and(here, eq(spacePackages.placedByOffer, false)))
      .returning({ packageId: spacePackages.packageId });
    return { removed: kept.length > 0, disabledScheduleIds: [] };
  }
  const removed = await tx.delete(spacePackages).where(here).returning({
    packageId: spacePackages.packageId,
  });
  const disabledScheduleIds = await disableArmedSchedules(
    tx,
    and(eq(schedules.packageId, packageId), eq(schedules.spaceId, spaceId)),
  );
  return { removed: removed.length > 0, disabledScheduleIds };
}
