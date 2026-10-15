// SPDX-License-Identifier: Apache-2.0

import { toggleValue } from "../lib/toggle-value";
import { createKeyedLocalStore } from "./local-storage";

/** Hidden columns per table, persisted; a preference, so kept out of the URL (like the cards/table view). */

const NONE: string[] = [];

const hiddenColumns = createKeyedLocalStore<string[]>(
  "appstrate-columns-",
  (value) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : NONE,
  NONE,
);

export interface ColumnVisibility {
  hidden: string[];
  toggle: (id: string) => void;
}

/** `key` names the TABLE, not the screen: the same table keeps its columns wherever it is shown. */
export function useColumnVisibility(key: string): ColumnVisibility {
  const [hidden, setHidden] = hiddenColumns.useValue(key);
  return { hidden, toggle: (id) => setHidden(toggleValue(hidden, id)) };
}
