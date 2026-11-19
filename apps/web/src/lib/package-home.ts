// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import { packagePermission } from "@appstrate/core/permissions";

type SpaceOption = { id: string; name: string; permissions: string[]; personal?: boolean };

/**
 * The spaces a package may be moved INTO: everything but its current home
 * (`packages.home_space_id`, RBAC spec §6.9) and any PERSONAL space, where the
 * caller holds the type's `write` (what the server demands of the destination).
 * Not the same as "is a member": `GET /api/spaces` also lists `closed` spaces
 * nobody joined, with an empty permission array.
 *
 * A personal space passes the permission test but the API answers 409
 * `home_move_into_personal_space` (§3.6), so it is not offered.
 */
export function writableDestinations<T extends SpaceOption>(
  spaces: readonly T[] | undefined,
  type: PackageType,
  homeSpaceId: string | null | undefined,
): T[] {
  const required = packagePermission(type, "write");
  return (spaces ?? []).filter(
    (space) => space.id !== homeSpaceId && !space.personal && space.permissions.includes(required),
  );
}

/**
 * The home's name on a detail header's meta line (`PackageOriginMeta`): said only where no tile
 * names it — the home's tile leads when the package is active there — and not while the tiles
 * are read (`spaceIds` undefined), so the line does not jump.
 */
export function homeNameBesideTiles({
  homeSpaceId,
  homeSpaceName,
  spaceIds,
}: {
  homeSpaceId: string | null;
  homeSpaceName?: string | null;
  spaceIds: readonly string[] | undefined;
}): string | null | undefined {
  if (!spaceIds || (homeSpaceId && spaceIds.includes(homeSpaceId))) return null;
  return homeSpaceName;
}
