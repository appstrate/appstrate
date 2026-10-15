// SPDX-License-Identifier: Apache-2.0

/**
 * What the catalogue reads off a package's placements. In a space a row is
 * `active`, `inactive` (settings kept) or `offered` (placed by a share, switched on
 * by nobody: the wire's `none`). A system package answers `active` without a row
 * and is switched off by the sticky opt-out row, like any other.
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
 * The wire's `none` means "no row in this space", and only a share's `none` is an
 * offer: a system integration or a home package nobody enabled is simply off.
 */
function stateOf(placement: LibraryPlacement): PlacementState {
  if (placement.state === "active") return "active";
  return isPendingOffer(placement) ? "offered" : "inactive";
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

/** Its state in one space, or `null` when it is not placed there. */
export function placementIn(placement: CataloguePlacement, spaceId: string): PlacementState | null {
  if (placement.activeIn.includes(spaceId)) return "active";
  if (placement.offeredIn.includes(spaceId)) return "offered";
  return placement.inactiveIn.includes(spaceId) ? "inactive" : null;
}

/** Is this row one of the two tabs' subject? */
export function inPlacedTab(placement: CataloguePlacement): boolean {
  return !placement.unplaced;
}

/** One decision waiting: this package, shared with this space, by this person. */
export interface PendingShare {
  pkg: LibraryPackageItem;
  spaceId: string;
  /** `null` for a share nobody authored (the one a home move leaves behind). */
  sharedBy: string | null;
}

/**
 * Every decision waiting, across kinds — what "Partages en attente" lists.
 *
 * One entry per PLACEMENT, not per package: a package shared with two of the
 * reader's spaces asks two spaces to decide, and each answer is its own switch.
 */
export function pendingShares(packages: readonly LibraryPackageItem[]): PendingShare[] {
  return packages.flatMap((pkg) =>
    pkg.placements.filter(isPendingOffer).map((placement) => ({
      pkg,
      spaceId: placement.space_id,
      sharedBy: placement.shared_by?.name ?? null,
    })),
  );
}

/**
 * The space to read a package's detail FROM. The server answers only where the
 * package is placed, and the catalogue lists packages placed elsewhere than the
 * space the reader stands in: its home first, then any space that holds it.
 */
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
    placement.offeredIn[0] ??
    current ??
    undefined
  );
}
