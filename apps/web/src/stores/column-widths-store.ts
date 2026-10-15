// SPDX-License-Identifier: Apache-2.0

import { createKeyedLocalStore } from "./local-storage";

/**
 * The widths a person gave a table's columns, remembered across reloads.
 *
 * Same call as `column-visibility-store.ts`: a convenience per browser and per
 * table, never a location, and the table works without it. Keyed like that
 * store, by table only: no account identifier is written to storage.
 */

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
