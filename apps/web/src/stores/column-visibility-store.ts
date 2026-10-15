// SPDX-License-Identifier: Apache-2.0

import { toggleValue } from "../lib/toggle-value";
import { createKeyedLocalStore } from "./local-storage";

/**
 * Which columns a user has hidden, per table, remembered across reloads.
 *
 * A preference and not a location, so it stays out of the URL: a link to a
 * filtered list should open on the reader's own columns rather than impose the
 * sender's — the same call as the cards/table view.
 */

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
