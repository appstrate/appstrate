// SPDX-License-Identifier: Apache-2.0

// Per-space rows graded by what the reader may do: readonly (switch nowhere), single (one line
// with its switch), table (one row per space). Pure: the sheet renders through a portal.

import type { PackageType } from "@appstrate/core/validation";
import { placementIn, type CataloguePlacement, type PlacementState } from "./catalogue-placement";
import type { ActivationGate, ActivationRefusal } from "./catalogue-gates";

export interface SheetSpaceRow {
  id: string;
  name: string;
  state: PlacementState | null;
  /** Where it is edited. */
  home: boolean;
  offeredBy: string | null;
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
      offeredBy: placement.offeredBy[space.id] ?? null,
      mayToggle: gate.allowed,
      refusal: gate.refusal,
    };
  });
}

export function sheetSpaceMode(rows: readonly SheetSpaceRow[]): SheetSpaceMode {
  if (!rows.some((row) => row.mayToggle)) return "readonly";
  return rows.length === 1 ? "single" : "table";
}

export function sheetOffers(rows: readonly SheetSpaceRow[]): SheetSpaceRow[] {
  return rows.filter((row) => row.state === "offered");
}

export type ChatEnforceRefusal = "configure" | "publishFirst";

export interface SheetChatEnforce {
  checked: boolean;
  disabled: boolean;
  refusal: ChatEnforceRefusal | null;
}

/**
 * Whether a space imposes a SKILL on every chat conversation held in it (`chat_enforced`).
 * `null` = no switch: another type, or no placement to configure. A switched-off row keeps its flag.
 * Imposing needs a published version (the draft is never injected); releasing never does.
 * The right is the space's `configure` verdict, with no personal-space exemption, unlike activation.
 */
export function sheetChatEnforce(
  type: PackageType,
  row: Pick<SheetSpaceRow, "state">,
  facts: { enforced: boolean; published: boolean; mayConfigure: boolean },
): SheetChatEnforce | null {
  if (type !== "skill") return null;
  if (row.state !== "active" && row.state !== "inactive") return null;
  const refusal: ChatEnforceRefusal | null = !facts.mayConfigure
    ? "configure"
    : !facts.enforced && !facts.published
      ? "publishFirst"
      : null;
  return { checked: facts.enforced, disabled: refusal !== null, refusal };
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
