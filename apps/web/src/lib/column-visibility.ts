// SPDX-License-Identifier: Apache-2.0

import type { DataColumn } from "../components/data-table";

/**
 * The column that says WHICH row this is: the one marked `identity`, or else the first read
 * column. A tick or select before it is not the row's name. -1 when there is none.
 */
export function identityColumnIndex<T>(columns: DataColumn<T>[]): number {
  const marked = columns.findIndex((column) => column.identity && !column.control);
  return marked >= 0 ? marked : columns.findIndex((column) => !column.control);
}

/** The column the reader cannot hide: the row's name, when it has a head the menu can name. */
function requiredColumnId<T>(columns: DataColumn<T>[]): string | undefined {
  const column = columns[identityColumnIndex(columns)];
  return column?.header ? column.id : undefined;
}

/** A column with no header (the actions column) cannot be named in a menu: never offered, never hidden. */
export function columnMenu<T>(
  columns: DataColumn<T>[],
  visibility: { hidden: string[]; toggle: (id: string) => void },
) {
  const requiredId = requiredColumnId(columns);
  return {
    options: columns
      .filter((column) => column.header)
      .map((column) => ({
        id: column.id,
        label: column.header,
        required: column.id === requiredId,
      })),
    hidden: visibility.hidden,
    onToggle: visibility.toggle,
  };
}

export function visibleColumns<T>(columns: DataColumn<T>[], hidden: string[]): DataColumn<T>[] {
  const requiredId = requiredColumnId(columns);
  return columns.filter(
    (column) => column.id === requiredId || !column.header || !hidden.includes(column.id),
  );
}
