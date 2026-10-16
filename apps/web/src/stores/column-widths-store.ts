// SPDX-License-Identifier: Apache-2.0

import { useSettingDraft } from "../hooks/use-setting-draft";
import { createKeyedLocalStore } from "./local-storage";

/** Column widths per table, persisted like `column-visibility-store.ts`; no account identifier in storage. */

type ColumnWidths = Readonly<Record<string, number>>;

const NONE: ColumnWidths = {};

const columnWidths = createKeyedLocalStore<ColumnWidths>(
  "appstrate-column-widths-",
  (value) => {
    if (!value || typeof value !== "object") return NONE;
    const widths: Record<string, number> = {};
    for (const [id, width] of Object.entries(value)) {
      if (typeof width === "number" && Number.isFinite(width)) widths[id] = width;
    }
    return widths;
  },
  NONE,
);

/** `table` names the table; `width: null` gives a column back its declared width. */
export function useColumnWidths(table: string) {
  const [widths, setWidths] = columnWidths.useValue(table);
  const draft = useSettingDraft(widths);
  return {
    widths: draft.value,
    dirty: draft.dirty,
    save: async () => {
      setWidths(draft.value);
      draft.accept(draft.value);
    },
    discard: draft.reset,
    set: (id: string, width: number | null) => {
      draft.set((previous) => {
        const { [id]: _dropped, ...rest } = previous;
        return width === null ? rest : { ...rest, [id]: Math.round(width) };
      });
    },
  };
}
