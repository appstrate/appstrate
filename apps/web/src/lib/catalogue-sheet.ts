// SPDX-License-Identifier: Apache-2.0

/**
 * What a package's catalogue sheet says about SPACES, graded by what the reader
 * may do in them.
 *
 * The sheet does not ask "add it where?" through a menu and a button: two
 * gestures for a question whose answer reads better at a glance, the state in
 * each space with the switch on the same line. How much of that the reader gets
 * depends on their reach, and the grading is the rule this file pins:
 *
 * - **readonly** — the reader may switch it on or off nowhere. A line saying
 *   where it runs, and nothing to press.
 * - **single** — one space within reach. One line with its switch: a table of
 *   one row compares nothing.
 * - **table** — several. One row per space, which is the comparison the sheet
 *   is for.
 *
 * Pure, with a test, because the sheet renders through a portal the test
 * renderer does not draw.
 */

import type { PackageType } from "@appstrate/core/validation";
import { placementIn, type CataloguePlacement, type PlacementState } from "./catalogue-placement";
import type { ActivationGate, ActivationRefusal } from "./catalogue-gates";

export interface SheetSpaceRow {
  id: string;
  name: string;
  /** `null` when the package is not placed there at all. */
  state: PlacementState | null;
  /** The space it lives in, which is where it is edited. */
  home: boolean;
  /** Who offered it there, on an offer somebody made. */
  offeredBy: string | null;
  /** Whether the reader may flip THIS row's switch, in the direction it would go. */
  mayToggle: boolean;
  /** Why not, when the reader's standing there is known (`activationGate`). */
  refusal: ActivationRefusal | null;
}

export type SheetSpaceMode = "readonly" | "single" | "table";

export function sheetSpaceRows(
  placement: CataloguePlacement,
  spaces: readonly { id: string; name: string }[],
  /** The reader's verdict for switching it on (`next: true`) or off in that space. */
  gateOf: (spaceId: string, next: boolean) => ActivationGate,
  /** The space the reader is in: its row comes first, it is the one they act on. */
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

/** The offers waiting on this reader: placed by a share, switched on by nobody. */
export function sheetOffers(rows: readonly SheetSpaceRow[]): SheetSpaceRow[] {
  return rows.filter((row) => row.state === "offered");
}

/** Why a chat-enforcement switch cannot be flipped, when it cannot. */
export type ChatEnforceRefusal = "configure" | "publishFirst";

export interface SheetChatEnforce {
  checked: boolean;
  disabled: boolean;
  refusal: ChatEnforceRefusal | null;
}

/**
 * Whether a space imposes a SKILL on every chat conversation held in it, and
 * whether the reader may change that there (`chat_enforced` on the placement,
 * set through its PATCH).
 *
 * `null` means no switch at all: another type, or a space where the skill has
 * no placement to configure (an offer nobody took up, an absence). A switched
 * off row keeps its flag, which waits for re-activation.
 *
 * Imposing asks for a published version, since what is injected is never the
 * draft; releasing never does, so an unpublished skill can still be released.
 * The right is the space's `configure` verdict (`mayConfigurePackage`), with no
 * personal-space exemption, unlike activation.
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
