// SPDX-License-Identifier: Apache-2.0

/**
 * A collection as self-contained blocks stacked one under the next. It asks its
 * container for no width, so it is the shape for panels, modals and phones.
 */

import type { ReactNode } from "react";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { collectionVerdict, type CollectionState } from "./collection";
import { CollectionStates } from "./collection-states";

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

  if (verdict !== "items") {
    return (
      <CollectionStates
        verdict={verdict}
        state={state}
        skeleton={
          <div className="flex flex-col gap-2">
            {Array.from({ length: SKELETON_ITEMS }, (_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <div key={itemKey(item)}>{renderItem(item)}</div>
      ))}
    </div>
  );
}
