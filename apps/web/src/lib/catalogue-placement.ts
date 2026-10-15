// SPDX-License-Identifier: Apache-2.0

// In a space a row is `active`, `inactive` (settings kept) or `offered` (placed by a share,
// switched on by nobody: the wire's `none`). A system package is `active` without a row.

import type { LibraryPackageItem, LibraryPlacement } from "../hooks/use-library";

export type PlacementState = "active" | "inactive" | "offered";

export interface CataloguePlacement {
  /** `null` when it is not placed in the space on screen. */
  here: PlacementState | null;
  activeIn: string[];
  inactiveIn: string[];
  offeredIn: string[];
  /** By space id; `null` for an offer nobody authored (the share a home move leaves behind). */
  offeredBy: Record<string, string | null>;
  /** The space that governs the draft, `null` when the caller cannot reach it. */
  homeSpaceId: string | null;
}

// The wire's `none` means "no row in this space"; only a share's `none` is an offer.
function stateOf(placement: LibraryPlacement): PlacementState {
  if (placement.state === "active") return "active";
  return isPendingOffer(placement) ? "offered" : "inactive";
}

function isPendingOffer(placement: LibraryPlacement): boolean {
  return placement.state === "none" && placement.via === "shared";
}

export function cataloguePlacement(
  pkg: Pick<LibraryPackageItem, "placements" | "home_space_id">,
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
  };
}

export function placementIn(placement: CataloguePlacement, spaceId: string): PlacementState | null {
  if (placement.activeIn.includes(spaceId)) return "active";
  if (placement.offeredIn.includes(spaceId)) return "offered";
  return placement.inactiveIn.includes(spaceId) ? "inactive" : null;
}

export interface PendingShare {
  pkg: LibraryPackageItem;
  spaceId: string;
  /** `null` for a share nobody authored. */
  sharedBy: string | null;
}

/** One entry per PLACEMENT, not per package: each space's answer is its own switch. */
export function pendingShares(packages: readonly LibraryPackageItem[]): PendingShare[] {
  return packages.flatMap((pkg) =>
    pkg.placements.filter(isPendingOffer).map((placement) => ({
      pkg,
      spaceId: placement.space_id,
      sharedBy: placement.shared_by?.name ?? null,
    })),
  );
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
    placement.offeredIn[0] ??
    current ??
    undefined
  );
}
