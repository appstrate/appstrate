// SPDX-License-Identifier: Apache-2.0

/**
 * A collection as cards. The track is `repeat(auto-fill, minmax(<floor>, 1fr))`
 * rather than breakpoints, so the column count follows the container, not the window.
 */

import type { CSSProperties, ReactNode } from "react";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { collectionVerdict, type CollectionState } from "./collection";
import { CollectionStates } from "./collection-states";

const SKELETON_CARDS = 4;

export function CardGrid<T>({
  items,
  renderCard,
  itemKey,
  min = "20rem",
  ...state
}: {
  items: T[];
  renderCard: (item: T) => ReactNode;
  itemKey: (item: T) => string;
  /** The narrowest a card may be before the grid drops a column (thumbnails pass less). */
  min?: string;
} & CollectionState) {
  const verdict = collectionVerdict(state, items.length);

  if (verdict !== "items") {
    return (
      <CollectionStates
        verdict={verdict}
        state={state}
        skeleton={
          <Grid min={min}>
            {Array.from({ length: SKELETON_CARDS }, (_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </Grid>
        }
      />
    );
  }

  return (
    <Grid min={min}>
      {items.map((item) => (
        // The cell fills its row and the card fills the cell. Without the
        // second half, a card with one line of description sits short beside
        // one with two, and every card would have to remember `h-full` for
        // itself.
        <div key={itemKey(item)} className="h-full [&>*]:h-full">
          {renderCard(item)}
        </div>
      ))}
    </Grid>
  );
}

function Grid({ min, children }: { min: string; children: ReactNode }) {
  return (
    // `min(…, 100%)` keeps a card from overflowing a container narrower than
    // the floor itself. The track goes through a custom property rather than an
    // interpolated class name because Tailwind reads class names as literals in
    // the source and would never generate `minmax(min(10rem,100%),1fr)`.
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(min(var(--card-min),100%),1fr))] gap-3"
      style={{ "--card-min": min } as CSSProperties}
    >
      {children}
    </div>
  );
}
