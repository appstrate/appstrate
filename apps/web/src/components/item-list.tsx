// SPDX-License-Identifier: Apache-2.0

/**
 * The third body of the Collection family: items stacked, one under the next.
 *
 * The family's other two ask something of their container. `DataTable` wants
 * width, and columns that line up from one row to the next — put it in a card
 * on a padded page and it clips, which is exactly what happened to the
 * integration tables. `CardGrid` wants 20rem per card before it will take a
 * second column. **This one asks for nothing**, which is why it is the shape
 * that works in a panel, in a modal, in a tab beside a sidebar, on a phone —
 * and why it should have been built first rather than last.
 *
 * What makes an item here rather than a row of a table: the item is a
 * SELF-CONTAINED BLOCK. It carries its own border and decides its own internal
 * layout, so nothing has to line up with the item above it. A table is the
 * opposite bargain — alignment across rows, paid for in width.
 *
 * It takes `CardGrid`'s contract verbatim (`items`, `itemKey`, plus the four
 * `CollectionState` props) and answers the states in the same order, from the
 * same file: **failure, then loading, then emptiness**. A caller hands any of
 * the three bodies the same props and gets the same behaviour; that is the
 * whole point of there being a family at all.
 *
 * It is deliberately NOT `CardGrid` with one column. The two are one line of
 * CSS apart today and it is tempting, but the merge would be three props
 * (a column floor, a gap, a skeleton shape) configuring a component instead of
 * a component being used, and the call sites would stop saying which shape
 * they meant. If a third arrangement ever turns up, merge them then, with the
 * evidence.
 */

import type { ReactNode } from "react";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { collectionVerdict, type CollectionState } from "./collection";
import { ErrorState } from "./page-states";

const SKELETON_ITEMS = 3;

export function ItemList<T>({
  items,
  renderItem,
  itemKey,
  ...state
}: {
  items: T[];
  renderItem: (item: T) => ReactNode;
  itemKey: (item: T) => string;
} & CollectionState) {
  const verdict = collectionVerdict(state, items.length);

  // A failure always draws something, whether or not the caller wrote the
  // sentence. This is the body where it matters most: the panel this was
  // extracted from had no failure branch at all, so a 500 rendered as "there
  // is nothing here" — a list saying it is empty when nobody knows that.
  if (verdict === "error") return <Frame>{state.error ?? <ErrorState compact />}</Frame>;
  if (verdict === "loading") {
    return (
      <div className="space-y-2">
        {Array.from({ length: SKELETON_ITEMS }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }
  if (verdict === "empty") return <Frame>{state.empty}</Frame>;

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={itemKey(item)}>{renderItem(item)}</div>
      ))}
    </div>
  );
}

/**
 * The table's frame, worn by the STATES only.
 *
 * Same reasoning as the card grid: the items sit loose on the canvas and carry
 * their own borders, so an empty list has no shape of its own and its message
 * would float in the middle of nothing. Inside the frame, "there is nothing
 * here" occupies the place the list would have occupied, which is what makes
 * it read as an answer rather than as a page that failed to render.
 */
function Frame({ children }: { children: ReactNode }) {
  return <div className="bg-card overflow-hidden rounded-lg border shadow-sm">{children}</div>;
}
