// SPDX-License-Identifier: Apache-2.0

import { createKeyedLocalStore } from "./local-storage";

/** Column widths per table, persisted like `column-visibility-store.ts`; keyed by table only (no account identifier in storage). */

export type ColumnWidths = Readonly<Record<string, number>>;

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

export interface ColumnWidthsControl {
  widths: ColumnWidths;
  set: (id: string, width: number) => void;
}

/** `table` is the table's stable, untranslated id: it keeps its widths wherever it is shown. */
export function useColumnWidths(table: string): ColumnWidthsControl {
  const [widths, setWidths] = columnWidths.useValue(table);
  return {
    widths,
    set: (id, width) => setWidths({ ...widths, [id]: Math.round(width) }),
  };
}
