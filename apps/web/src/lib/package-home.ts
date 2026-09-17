// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import { PACKAGE_PERMISSIONS } from "./package-permissions";

/** One row of `GET /api/spaces`, narrowed to what a move destination has to carry. */
type SpaceOption = { id: string; name: string; permissions: string[]; personal?: boolean };

/**
 * The spaces a package may be moved INTO: everything but its current home
 * (`packages.home_space_id`, RBAC spec §6.9) and the caller's own PERSONAL
 * space, where the caller holds the type's `write`.
 *
 * That permission is exactly what the server demands of the DESTINATION, so a
 * space offered without it would only answer 403. It is not the same test as
 * "is a member": `GET /api/spaces` also lists `closed` spaces nobody joined,
 * and those come back with an empty permission array.
 *
 * The personal space passes the permission test — its owner holds `admin`
 * there — and is refused by the API all the same (409
 * `home_move_into_personal_space`): a personal space homes only what is created
 * or forked in it, since a package moved into one leaves every administrator's
 * reach (§3.6). Offering it would only be a button that answers 409.
 */
export function writableDestinations<T extends SpaceOption>(
  spaces: readonly T[] | undefined,
  type: PackageType,
  homeSpaceId: string | null | undefined,
): T[] {
  const required = `${PACKAGE_PERMISSIONS[type].resource}:write`;
  return (spaces ?? []).filter(
    (space) => space.id !== homeSpaceId && !space.personal && space.permissions.includes(required),
  );
}
