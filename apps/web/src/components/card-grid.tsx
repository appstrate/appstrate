// SPDX-License-Identifier: Apache-2.0

/**
 * The other half of the Collection family: a list of entities as cards.
 *
 * It exists to be SYMMETRICAL with `DataTable`, not because a card grid is hard
 * to draw. One line of `grid-cols-1 md:grid-cols-2` is easy; what is not easy
 * is remembering that a collection also has a loading shape, an empty sentence
 * and a failure — and every screen that wrote the easy line forgot the rest and
 * handled it by returning early, ABOVE the toolbar. That is where the empty
 * package list lost its bar and had to re-offer its own actions as two
 * unlabelled squares.
 *
 * So this takes the same contract as the table (`items`, `isLoading`,
 * `isError`, `empty`) and answers it in the same places. A caller that hands
 * both of them the same props has nothing left to branch on, and the bar and
 * the footer stop depending on what the body happens to contain.
 *
 * Two decisions worth knowing:
 *
 * - **The states come from `collection.ts`**, which owns the ORDER the table
 *   uses too — failure, then loading, then emptiness. Written here once, the
 *   two bodies answered the same props differently within a day.
 * - **No breakpoints.** `repeat(auto-fill, minmax(<floor>, 1fr))` says "as many
 *   columns as fit, none narrower than this" in one value, and the browser
 *   recomputes it against the CONTAINER. A ladder of `md:` / `lg:` classes
 *   answers the WINDOW, which is why the package list stayed at two columns on
 *   a 1440px screen while the same grid beside a sidebar wanted one. Same
 *   lesson as the table's tiers, one step further: here nothing has to be
 *   declared at all.
 * - **The states wear the table's frame.** Cards sit loose on the canvas, so an
 *   empty grid has no shape of its own and its message floats. Inside the same
 *   white card the table uses, "there is nothing here" occupies the place the
 *   collection would have occupied, which is what makes it read as an answer
 *   rather than as a page that failed to render.
 */

import type { CSSProperties, ReactNode } from "react";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { collectionVerdict, type CollectionState } from "./collection";
import { ErrorState } from "./page-states";

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
  /**
   * The narrowest a card may be before the grid drops a column. The default is
   * the width a card carrying a description needs to be readable; the document
   * gallery passes `10rem`, because its cards are thumbnails and a 20rem
   * thumbnail is a poster. It is the ONLY thing that varies between the grids,
   * which is why it is the only prop here.
   */
  min?: string;
} & CollectionState) {
  const verdict = collectionVerdict(state, items.length);

  // A failure always draws something, whether or not the caller wrote the
  // sentence: `isError` is not a suggestion.
  if (verdict === "error") return <Frame>{state.error ?? <ErrorState compact />}</Frame>;
  if (verdict === "loading") {
    return (
      <Grid min={min}>
        {Array.from({ length: SKELETON_CARDS }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </Grid>
    );
  }
  if (verdict === "empty") return <Frame>{state.empty}</Frame>;

  return (
    <Grid min={min}>
      {items.map((item) => (
        // The cell fills its row and the card fills the cell. Without the
        // second half, a card with one line of description sits short beside
        // one with two, and every card has to remember `h-full` for itself —
        // which is the kind of thing a family exists to stop having to
        // remember. `PackageCard` did; `IntegrationCard` did not.
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

/** The table's frame, so an empty grid and an empty table look like one thing. */
function Frame({ children }: { children: ReactNode }) {
  return <div className="bg-card overflow-hidden rounded-lg border shadow-sm">{children}</div>;
}
