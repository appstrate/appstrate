// SPDX-License-Identifier: Apache-2.0

import { useSettingDraft } from "../hooks/use-setting-draft";
import type { DataColumn } from "../components/data-table";
import { columnMenu, visibleColumns } from "../lib/column-visibility";
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

/**
 * The columns the reader keeps, and the menu that lets them choose. `key` names the TABLE, not
 * the screen: the same table keeps its columns wherever it is shown.
 */
export function useColumnVisibility<T>(key: string, all: DataColumn<T>[]) {
  const [hidden, setHidden] = hiddenColumns.useValue(key);
  const draft = useSettingDraft(hidden);
  return {
    columns: visibleColumns(all, hidden),
    menu: {
      ...columnMenu(all, {
        hidden: draft.value,
        toggle: (id) => draft.set((previous) => toggleValue(previous, id)),
      }),
      dirty: draft.dirty,
      onSave: () => {
        setHidden(draft.value);
        draft.accept(draft.value);
      },
      onDiscard: draft.reset,
    },
  };
}
