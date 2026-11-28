// SPDX-License-Identifier: Apache-2.0

import { LOCAL_STORAGE_KEYS, createLocalStore, jsonCodec } from "@appstrate/ui/local-storage";

/** Column widths per table, persisted like `column-visibility-store.ts`; no account identifier in storage. */

type ColumnWidths = Readonly<Record<string, number>>;

const NONE: ColumnWidths = {};

const columnWidths = createLocalStore(
  LOCAL_STORAGE_KEYS.columnWidths,
  jsonCodec((value): ColumnWidths => {
    if (!value || typeof value !== "object") return NONE;
    const widths: Record<string, number> = {};
    for (const [id, width] of Object.entries(value)) {
      if (typeof width === "number" && Number.isFinite(width)) widths[id] = width;
    }
    return widths;
  }),
);

/** `table` names the table; `width: null` gives a column back its declared width. */
export function useColumnWidths(table: string) {
  const [widths, setWidths] = columnWidths.useValue(table);
  return {
    widths,
    set: (id: string, width: number | null) => {
      const { [id]: _dropped, ...rest } = widths;
      setWidths(width === null ? rest : { ...rest, [id]: Math.round(width) });
    },
  };
}
