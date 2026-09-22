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
 * A SYSTEM package has a placement in every space by construction and, with no
 * row of its own, the wire already answers `active` there
 * (`placementState` / `isActiveHere`, `services/package-activation.ts`). It is
 * not a fourth state and it is not switch-less: a space switches it OFF by
 * materialising the row that says so — the sticky opt-out — and back on the
 * same way. The screen treats it like any other row, which is what the server
 * does.
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
}

/**
 * The wire's `none` means "no row in this space", whatever put the package
 * there — and only one of those reasons is an OFFER. A placement made by a
 * share and switched on by nobody asks somebody for a decision; a SYSTEM
 * integration nobody switched on, or a package at home nobody enabled, is
 * simply off. Reading every `none` as an offer made the navigation count one
 * "offer" per Appstrate integration per space — dozens on a real instance.
 */
function stateOf(placement: LibraryPlacement): PlacementState {
  if (placement.state === "active") return "active";
  return placement.state === "none" && placement.via === "shared" ? "offered" : "inactive";
}

/** An offer nobody has taken up — the only placement that waits on a person. */
function isPendingOffer(placement: LibraryPlacement): boolean {
  return placement.state === "none" && placement.via === "shared";
}

export function cataloguePlacement(
  pkg: Pick<LibraryPackageItem, "placements" | "home_space_id" | "source">,
  spaceId: string | null | undefined,
): CataloguePlacement {
  const byState = { active: [] as string[], inactive: [] as string[], offered: [] as string[] };
  const offeredBy: Record<string, string | null> = {};
  for (const placement of pkg.placements) {
    byState[stateOf(placement)].push(placement.space_id);
    if (isPendingOffer(placement))
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
    // Nothing of this caller's yet: no space holds it by its home or by an
    // offer, and no space runs it. A system integration readable everywhere
    // but switched on nowhere is exactly that — something to DISCOVER — even
    // though the wire lists it with a placement in every space.
    unplaced: !pkg.placements.some(
      (placement) => placement.via !== "system" || placement.state === "active",
    ),
  };
}

/** Is this row one of the two tabs' subject? */
export function inPlacedTab(placement: CataloguePlacement): boolean {
  return !placement.unplaced;
}

/**
 * The one number the navigation carries: offers nobody has taken up.
 *
 * It counts PLACEMENTS, not packages — one package offered to three spaces is
 * three decisions, taken by three different people.
 */
export function pendingOfferCount(packages: readonly LibraryPackageItem[]): number {
  return packages.reduce((total, pkg) => total + pkg.placements.filter(isPendingOffer).length, 0);
}
