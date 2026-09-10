// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import { PACKAGE_PERMISSIONS } from "./package-permissions";

/** One row of `GET /api/spaces`, narrowed to what a move destination has to carry. */
type SpaceOption = { id: string; name: string; permissions: string[] };

/**
 * The spaces a package may be moved INTO: everything but its current home
 * (`packages.home_space_id`, RBAC spec §6.9) where the caller holds the type's
 * `write`.
 *
 * That permission is exactly what the server demands of the DESTINATION, so a
 * space offered without it would only answer 403. It is not the same test as
 * "is a member": `GET /api/spaces` also lists `closed` spaces nobody joined,
 * and those come back with an empty permission array.
 */
export function writableDestinations<T extends SpaceOption>(
  spaces: readonly T[] | undefined,
  type: PackageType,
  homeSpaceId: string | null | undefined,
): T[] {
  const required = `${PACKAGE_PERMISSIONS[type].resource}:write`;
  return (spaces ?? []).filter(
    (space) => space.id !== homeSpaceId && space.permissions.includes(required),
  );
}
