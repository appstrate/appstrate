// SPDX-License-Identifier: Apache-2.0

// In a space a placement is `active` or `inactive` (switched off, settings kept): a share that
// nobody switched on is the second. A system package is `active` without a row.

import type { LibraryPackageItem, LibraryPlacement } from "../hooks/use-library";

export type PlacementState = "active" | "inactive";

export interface CataloguePlacement {
  /** `null` when it is not placed in the space on screen. */
  here: PlacementState | null;
  activeIn: string[];
  inactiveIn: string[];
  /** By space id, for a shared placement that is not switched on; `null` when nobody authored it (the share a home move leaves behind). */
  sharedBy: Record<string, string | null>;
  /** The space that governs the draft, `null` when the caller cannot reach it. */
  homeSpaceId: string | null;
  /** Placed nowhere this caller can see. */
  unplaced: boolean;
}

// The wire's `none` (no row, default off) reads like `inactive`.
function stateOf(placement: LibraryPlacement): PlacementState {
  return placement.state === "active" ? "active" : "inactive";
}

export function cataloguePlacement(
  pkg: Pick<LibraryPackageItem, "placements" | "home_space_id" | "source">,
  spaceId: string | null | undefined,
): CataloguePlacement {
  const byState = { active: [] as string[], inactive: [] as string[] };
  const sharedBy: Record<string, string | null> = {};
  for (const placement of pkg.placements) {
    const state = stateOf(placement);
    byState[state].push(placement.space_id);
    if (state === "inactive" && placement.via === "shared")
      sharedBy[placement.space_id] = placement.shared_by?.name ?? null;
  }
  const mine = spaceId
    ? pkg.placements.find((placement) => placement.space_id === spaceId)
    : undefined;
  return {
    here: mine ? stateOf(mine) : null,
    activeIn: byState.active,
    inactiveIn: byState.inactive,
    sharedBy,
    homeSpaceId: pkg.home_space_id,
    // A system integration switched on nowhere is still something to DISCOVER, though the wire
    // lists it with a placement in every space.
    unplaced: !pkg.placements.some(
      (placement) => placement.via !== "system" || placement.state === "active",
    ),
  };
}

export function placementIn(placement: CataloguePlacement, spaceId: string): PlacementState | null {
  if (placement.activeIn.includes(spaceId)) return "active";
  return placement.inactiveIn.includes(spaceId) ? "inactive" : null;
}

export function inPlacedTab(placement: CataloguePlacement): boolean {
  return !placement.unplaced;
}

/** The space to read a package's detail FROM: the server answers only where it is placed. Home first, then any holder. */
export function detailSpace(
  placement: CataloguePlacement,
  spaces: readonly { id: string }[],
  current: string | null,
): string | undefined {
  if (placement.here) return current ?? undefined;
  const reachable = (id: string | null) =>
    id && spaces.some((space) => space.id === id) ? id : undefined;
  return (
    reachable(placement.homeSpaceId) ??
    placement.activeIn[0] ??
    placement.inactiveIn[0] ??
    current ??
    undefined
  );
}
