// SPDX-License-Identifier: Apache-2.0

/**
 * What a package's catalogue sheet says about SPACES, graded by what the reader
 * may do in them.
 *
 * The sheet used to ask "add it where?" through a menu and a button: two
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
import type { CataloguePlacement, PlacementState } from "./catalogue-placement";

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
}

export type SheetSpaceMode = "readonly" | "single" | "table";

export function sheetSpaceRows(
  placement: CataloguePlacement,
  spaces: readonly { id: string; name: string }[],
  /** The reader's verdict for switching it on (`next: true`) or off in that space. */
  mayToggle: (spaceId: string, next: boolean) => boolean,
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
    const state: PlacementState | null = placement.activeIn.includes(space.id)
      ? "active"
      : placement.offeredIn.includes(space.id)
        ? "offered"
        : placement.inactiveIn.includes(space.id)
          ? "inactive"
          : null;
    return {
      id: space.id,
      name: space.name,
      state,
      home: placement.homeSpaceId === space.id,
      offeredBy: placement.offeredBy[space.id] ?? null,
      mayToggle: mayToggle(space.id, state !== "active"),
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
