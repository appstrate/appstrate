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
 * - **everywhere** — a system agent, skill or MCP server is readable in every
 *   space without being switched on. No switch exists, so none is drawn.
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

export type SheetSpaceMode = "everywhere" | "readonly" | "single" | "table";

export function sheetSpaceRows(
  placement: CataloguePlacement,
  spaces: readonly { id: string; name: string }[],
  /** The reader's verdict for switching it on (`next: true`) or off in that space. */
  mayToggle: (spaceId: string, next: boolean) => boolean,
): SheetSpaceRow[] {
  return spaces.map((space) => {
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

export function sheetSpaceMode(
  placement: CataloguePlacement,
  rows: readonly SheetSpaceRow[],
): SheetSpaceMode {
  if (placement.everywhere) return "everywhere";
  if (!rows.some((row) => row.mayToggle)) return "readonly";
  return rows.length === 1 ? "single" : "table";
}

/** The offers waiting on this reader: placed by a share, switched on by nobody. */
export function sheetOffers(rows: readonly SheetSpaceRow[]): SheetSpaceRow[] {
  return rows.filter((row) => row.state === "offered");
}
