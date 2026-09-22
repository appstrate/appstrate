// SPDX-License-Identifier: Apache-2.0

/**
 * What the catalogue knows about one package, read off its PLACEMENTS.
 *
 * The placement model (#1437) has three axes and the catalogue is their one
 * projection: a package is placed in a space by its home or by a share, and
 * that placement is separately switched on. So a row has three possible states
 * in a given space, and they are not degrees of one another:
 *
 * - **active** — placed here and switched on. It runs.
 * - **inactive** — placed here, switched off. Its per-space settings are kept,
 *   and switching it back on costs nothing.
 * - **offered** — placed here by a share and switched on by NOBODY yet. This is
 *   what a pending offer is: not an inbox item to accept, a placement whose
 *   state is `none` (RBAC spec §6.10).
 *
 * A package with no placement at all is not in this vocabulary: it is not
 * placed, which is what the catalogue's second tab is for.
 *
 * A pure function with its own test because it is the rule the whole screen
 * reads from, and because the wire says `none` where the interface says
 * "offered" — a word swap nobody should have to make twice.
 */

import type { LibraryPackageItem, LibraryPlacement } from "../hooks/use-library";

export type PlacementState = "active" | "inactive" | "offered";

/** Every state the package holds across the spaces this caller reaches. */
export interface CataloguePlacement {
  /** Its state in the space on screen, or `null` when it is not placed there. */
  here: PlacementState | null;
  /** Space ids where it is active, the space on screen included. */
  activeIn: string[];
  /** Space ids where it is placed and switched off. */
  inactiveIn: string[];
  /** Space ids where it was offered and nobody switched it on. */
  offeredIn: string[];
  /**
   * Who made each offer, by space id — `null` for an offer nobody authored (the
   * reconciling share a home move leaves behind, `shared_by: null`).
   */
  offeredBy: Record<string, string | null>;
  /** The space that governs the draft, or `null` when the caller cannot reach it. */
  homeSpaceId: string | null;
  /** Placed nowhere this caller can see: the second tab's subject. */
  unplaced: boolean;
  /**
   * Readable everywhere without being switched on — what a system agent, skill
   * or MCP server is. An integration is NOT: it has a real switch, and the
   * caller passes `false` for it.
   */
  everywhere: boolean;
}

function stateOf(placement: LibraryPlacement): PlacementState {
  if (placement.state === "active") return "active";
  return placement.state === "none" ? "offered" : "inactive";
}

export function cataloguePlacement(
  pkg: Pick<LibraryPackageItem, "placements" | "home_space_id" | "source">,
  spaceId: string | null | undefined,
  options: { everywhere?: boolean } = {},
): CataloguePlacement {
  const byState = { active: [] as string[], inactive: [] as string[], offered: [] as string[] };
  const offeredBy: Record<string, string | null> = {};
  for (const placement of pkg.placements) {
    byState[stateOf(placement)].push(placement.space_id);
    if (placement.state === "none")
      offeredBy[placement.space_id] = placement.shared_by?.name ?? null;
  }
  const mine = spaceId
    ? pkg.placements.find((placement) => placement.space_id === spaceId)
    : undefined;
  return {
    here: mine ? stateOf(mine) : null,
    activeIn: byState.active,
    inactiveIn: byState.inactive,
    offeredIn: byState.offered,
    offeredBy,
    homeSpaceId: pkg.home_space_id,
    unplaced: pkg.placements.length === 0,
    everywhere: options.everywhere ?? false,
  };
}

/** Is this row one of the two tabs' subject? */
export function inPlacedTab(placement: CataloguePlacement): boolean {
  return !placement.unplaced || placement.everywhere;
}

/**
 * The one number the navigation carries: offers nobody has taken up.
 *
 * It counts PLACEMENTS, not packages — one package offered to three spaces is
 * three decisions, taken by three different people.
 */
export function pendingOfferCount(packages: readonly LibraryPackageItem[]): number {
  return packages.reduce(
    (total, pkg) => total + pkg.placements.filter((placement) => placement.state === "none").length,
    0,
  );
}
