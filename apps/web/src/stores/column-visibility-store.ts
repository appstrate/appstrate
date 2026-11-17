// SPDX-License-Identifier: Apache-2.0

import type { DataColumn } from "../components/data-table";
import { columnMenu, visibleColumns } from "../lib/column-visibility";
import { toggleValue } from "../lib/toggle-value";
import { createKeyedLocalStore } from "./local-storage";

/** Hidden columns per table, persisted; a preference, so kept out of the URL (like the cards/table view). */

const NONE: string[] = [];

/** `null` until the reader picks: the table then shows its own default. */
const hiddenColumns = createKeyedLocalStore<string[] | null>(
  "appstrate-columns-",
  (value) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null,
  null,
);

/**
 * The columns the reader keeps, and the menu that lets them choose. `key` names the TABLE, not
 * the screen: the same table keeps its columns wherever it is shown. `hiddenByDefault` applies
 * until the reader's first change, which is then kept as a whole.
 */
export function useColumnVisibility<T>(
  key: string,
  all: DataColumn<T>[],
  hiddenByDefault: string[] = NONE,
) {
  const [stored, setHidden] = hiddenColumns.useValue(key);
  const hidden = stored ?? hiddenByDefault;
  return {
    columns: visibleColumns(all, hidden),
    menu: columnMenu(all, { hidden, toggle: (id) => setHidden(toggleValue(hidden, id)) }),
  };
}
