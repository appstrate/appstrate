// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's map, assembled from one space's library per space the caller
 * reaches — for whoever may not read the organization's own.
 *
 * `GET /api/library` is an administrator's view by definition: owners and
 * admins only (`routes/library.ts`). Anybody else reads
 * `GET /api/spaces/{id}/library`, which is the SAME row shape with placements
 * narrowed to that one space — plus, as candidates with an empty `placements`,
 * the packages this caller could bring there (their home grants them `share`).
 *
 * Merging those responses gives a member the map an admin reads directly,
 * limited to the spaces they are in: the same screen, graded by the same rule
 * the server applies. Candidates are what Découvrir is for, and they only exist
 * in the space form, so this is also where that half gets its content.
 */

import type { LibraryPackageItem, LibraryResponse } from "../hooks/use-library";

const TYPES = ["agent", "skill", "mcp-server", "integration"] as const;

export function mergeSpaceLibraries(
  responses: readonly Pick<LibraryResponse, "spaces" | "packages">[],
): Pick<LibraryResponse, "spaces" | "packages"> {
  const spaces = new Map<string, LibraryResponse["spaces"][number]>();
  const byType = Object.fromEntries(
    TYPES.map((type) => [type, new Map<string, LibraryPackageItem>()]),
  ) as Record<(typeof TYPES)[number], Map<string, LibraryPackageItem>>;

  for (const response of responses) {
    for (const space of response.spaces) spaces.set(space.id, space);
    for (const type of TYPES) {
      for (const row of response.packages[type] ?? []) {
        const seen = byType[type].get(row.id);
        // The package's own facts (home, verdicts) are the same from every
        // space; only its placements differ, one space's worth per response.
        byType[type].set(
          row.id,
          seen ? { ...seen, placements: [...seen.placements, ...row.placements] } : row,
        );
      }
    }
  }

  return {
    // The default space first, as the organization's own view orders them.
    spaces: [...spaces.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
    packages: Object.fromEntries(
      TYPES.map((type) => [type, [...byType[type].values()]]),
    ) as LibraryResponse["packages"],
  };
}
