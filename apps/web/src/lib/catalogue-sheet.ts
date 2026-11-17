// SPDX-License-Identifier: Apache-2.0

// Per-space rows graded by what the reader may do: readonly (switch nowhere), single (one line
// with its switch), table (one row per space). Pure: the sheet renders through a portal.

import { placementIn, type CataloguePlacement, type PlacementState } from "./catalogue-placement";
import type { ActivationGate, ActivationRefusal } from "./catalogue-gates";

export interface SheetSpaceRow {
  id: string;
  name: string;
  state: PlacementState | null;
  /** Where it is edited. */
  home: boolean;
  /** Placed by someone else and not switched on: switching it on is the consent. */
  shared: boolean;
  sharedBy: string | null;
  mayToggle: boolean;
  refusal: ActivationRefusal | null;
}

export type SheetSpaceMode = "readonly" | "single" | "table";

export function sheetSpaceRows(
  placement: CataloguePlacement,
  spaces: readonly { id: string; name: string }[],
  gateOf: (spaceId: string, next: boolean) => ActivationGate,
  /** Its row comes first: it is the one they act on. */
  currentSpaceId?: string | null,
): SheetSpaceRow[] {
  const ordered = currentSpaceId
    ? [
        ...spaces.filter((space) => space.id === currentSpaceId),
        ...spaces.filter((space) => space.id !== currentSpaceId),
      ]
    : spaces;
  return ordered.map((space) => {
    const state = placementIn(placement, space.id);
    const gate = gateOf(space.id, state !== "active");
    return {
      id: space.id,
      name: space.name,
      state,
      home: placement.homeSpaceId === space.id,
      shared: space.id in placement.sharedBy,
      sharedBy: placement.sharedBy[space.id] ?? null,
      mayToggle: gate.allowed,
      refusal: gate.refusal,
    };
  });
}

export function sheetSpaceMode(rows: readonly SheetSpaceRow[]): SheetSpaceMode {
  if (!rows.some((row) => row.mayToggle)) return "readonly";
  return rows.length === 1 ? "single" : "table";
}

/**
 * What the sheet says about a version the address pinned: `missing` when the
 * server has no such version (deleted since the link was made), `behind` when
 * the spaces run a newer one — a placement selects no version, outside its
 * home a package runs its latest published one — and `current` otherwise.
 * An unpinned sheet has no state.
 */
export type PinnedVersionState = "missing" | "behind" | "current";

export function pinnedVersionState(facts: {
  pinned: string | undefined;
  missing: boolean;
  latestPublished: string | null | undefined;
}): PinnedVersionState | null {
  if (!facts.pinned) return null;
  if (facts.missing) return "missing";
  return facts.latestPublished && facts.latestPublished !== facts.pinned ? "behind" : "current";
}
