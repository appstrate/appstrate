// SPDX-License-Identifier: Apache-2.0

import { Fragment, type ReactNode } from "react";
import { cn } from "../cn.ts";

/**
 * The colour of a stacked tile's ring: the container's `--tile-ring` (the colour of the surface
 * the stack sits on, which the container sets for each of its states: a card, a table row, a
 * conversation row or the chat's top-bar trigger), else the page background. It keeps the
 * overlapping edges readable.
 */
const TILE_RING = "ring-2 ring-(--tile-ring,var(--background))";

/** The box of a stacked tile in a list's line (a cell, a card): every stack's, so they line up. */
export const STACK_TILE = "size-4 rounded-[4px]";

/** How far each tile slides under the one before it: little, so a logo keeps what it shows. */
const OVERLAP = "-ml-0.5";

/**
 * Each tile its own stacking context, so its background and its content are painted together, in
 * the stack's order. Without it, content that opens a layer of its own (an Iconify glyph carries a
 * `transform`, a dimmed one `opacity`) is painted above every tile's background, and a tile behind
 * shows over the one in front.
 */
const TILE_LAYER = "isolate";

/**
 * Tiles overlapping ({@link OVERLAP}), the first in front and each next one behind it, each
 * ringed in {@link TILE_RING}. Past `max`, the rest is counted as « +N » in a tile of `tileClass`.
 * The one stack every listing draws — spaces, integrations — whatever its tiles are.
 */
export function TileStack<T>({
  items,
  keyOf,
  render,
  tileClass,
  max,
  testId,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** One tile; `className` carries the ring and the overlap, and must reach its outer box. */
  render: (item: T, className: string) => ReactNode;
  /** The size and corners of a tile, which the « +N » tile takes too. */
  tileClass: string;
  max?: number;
  testId?: string;
}) {
  const shown = max === undefined ? items : items.slice(0, max);
  const hidden = items.length - shown.length;
  // Reversed in the DOM, read in order on screen: the first tile is painted last, in front.
  return (
    <span className="flex shrink-0 flex-row-reverse items-center" data-testid={testId}>
      {hidden > 0 && (
        <span
          className={cn(
            "bg-muted text-muted-foreground flex shrink-0 items-center justify-center text-[10px] leading-none font-medium tabular-nums",
            tileClass,
            TILE_LAYER,
            TILE_RING,
            OVERLAP,
          )}
        >
          +{hidden}
        </span>
      )}
      {shown
        .map((item, index) => (
          <Fragment key={keyOf(item)}>
            {render(item, cn(TILE_LAYER, TILE_RING, index > 0 && OVERLAP))}
          </Fragment>
        ))
        .reverse()}
    </span>
  );
}
