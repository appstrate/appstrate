// SPDX-License-Identifier: Apache-2.0

/**
 * A package OFFERED to its organization (RBAC spec §6.10): placed and active in
 * every space of the organization that holds no `space_packages` row of its own
 * (a row always wins, `enabled = false` being the sticky opt-out). Presence of
 * the `org_package_offers` row is the offer; there is no state.
 *
 * Authority is the route's (`assertPackageOfferAccess`), re-asked here against
 * the home locked by {@link loadPlaceablePackage}, exactly as `placePackage` does.
 */

import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgPackageOffers, schedules, spacePackages, spaces } from "@appstrate/db/schema";
import { forbidden, invalidRequest } from "../lib/errors.ts";
import { assertHasPublishedVersion, loadPlaceablePackage } from "./space-packages.ts";
import type { PlacementAuthority } from "./space-packages.ts";
import { isActiveEverywhereByDefault } from "./package-activation.ts";
import { disableArmedSchedules, withdrawPlacement } from "./package-placement.ts";
import type { Tx } from "../lib/db-helpers.ts";

/** The locked package, after the home rule is re-asked against it. */
async function loadOfferablePackage(
  tx: Tx,
  orgId: string,
  packageId: string,
  authorizeHome: PlacementAuthority["authorizeHome"],
) {
  const pkg = await loadPlaceablePackage(tx, { orgId }, packageId, "update");
  if (!authorizeHome(pkg.homeSpaceId)) {
    throw forbidden(
      `Offering '${packageId}' to the organization requires the share permission in its home space — the package moved home while this request was in flight.`,
    );
  }
  return pkg;
}

/**
 * Offer `packageId` to the organization. Idempotent: a repeat leaves the offer
 * as it is and returns `created: false`. A package homed in a space needs a
 * published version (`409 package_has_no_version`): outside its home it runs
 * its latest published version. A system package has no home and no such rule.
 */
export async function offerPackageToOrg(params: {
  orgId: string;
  packageId: string;
  offeredBy: string;
  authorizeHome: PlacementAuthority["authorizeHome"];
}): Promise<{ created: boolean }> {
  const { orgId, packageId, offeredBy, authorizeHome } = params;
  return db.transaction(async (tx) => {
    const pkg = await loadOfferablePackage(tx, orgId, packageId, authorizeHome);
    if (pkg.offeredToOrg) return { created: false };
    if (isActiveEverywhereByDefault(pkg)) {
      throw invalidRequest(
        `'${packageId}' is already active in every space by the deployment's default: an offer would change nothing.`,
      );
    }
    if (pkg.homeSpaceId !== null) await assertHasPublishedVersion(pkg.id, tx);
    const inserted = await tx
      .insert(orgPackageOffers)
      .values({ orgId, packageId, offeredBy })
      .onConflictDoNothing()
      .returning({ packageId: orgPackageOffers.packageId });
    return { created: inserted.length > 0 };
  });
}

/**
 * Withdraw the offer. Idempotent (`removed: false` when there was none). In the
 * same transaction, the armed schedules of the package are disabled
 * (`package_removed`) in every space that loses it with the offer: spaces
 * whose row only decided about the offer (`placed_by_offer`, deleted here
 * through `withdrawPlacement`), and spaces of the organization holding no row
 * of their own, other than its home (still
 * placed, now merely inactive: its schedules fail visibly like any deactivated
 * package's), and none at all when the deployment's default alone still
 * activates it in every space.
 *
 * @returns the disabled schedule ids, whose jobs the caller removes once committed.
 */
export async function withdrawOrgOffer(params: {
  orgId: string;
  packageId: string;
  authorizeHome: PlacementAuthority["authorizeHome"];
}): Promise<{ removed: boolean; disabledScheduleIds: string[] }> {
  const { orgId, packageId, authorizeHome } = params;
  return db.transaction(async (tx) => {
    const pkg = await loadOfferablePackage(tx, orgId, packageId, authorizeHome);
    const removed = await tx
      .delete(orgPackageOffers)
      .where(and(eq(orgPackageOffers.orgId, orgId), eq(orgPackageOffers.packageId, packageId)))
      .returning({ packageId: orgPackageOffers.packageId });
    if (removed.length === 0) return { removed: false, disabledScheduleIds: [] };
    if (isActiveEverywhereByDefault(pkg)) {
      return { removed: true, disabledScheduleIds: [] };
    }
    // Rows that decided about the offer go with it, schedules off like any withdrawal.
    const offerRows = await tx
      .select({ spaceId: spacePackages.spaceId })
      .from(spacePackages)
      .innerJoin(spaces, eq(spaces.id, spacePackages.spaceId))
      .where(
        and(
          eq(spacePackages.packageId, packageId),
          eq(spacePackages.placedByOffer, true),
          eq(spaces.orgId, orgId),
        ),
      );
    const fromRows: string[] = [];
    for (const { spaceId } of offerRows) {
      fromRows.push(...(await withdrawPlacement(tx, packageId, spaceId)).disabledScheduleIds);
    }
    const lost = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.orgId, orgId),
          notInArray(
            spaces.id,
            tx
              .select({ id: spacePackages.spaceId })
              .from(spacePackages)
              .where(eq(spacePackages.packageId, packageId)),
          ),
          pkg.homeSpaceId === null ? undefined : ne(spaces.id, pkg.homeSpaceId),
        ),
      );
    if (lost.length === 0) return { removed: true, disabledScheduleIds: fromRows };
    const fromNoRow = await disableArmedSchedules(
      tx,
      and(
        eq(schedules.packageId, packageId),
        inArray(
          schedules.spaceId,
          lost.map((space) => space.id),
        ),
      ),
    );
    return { removed: true, disabledScheduleIds: [...fromRows, ...fromNoRow] };
  });
}
