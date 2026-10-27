// SPDX-License-Identifier: Apache-2.0

import type { DataColumn } from "../components/data-table";

/** The column that says WHICH row this is, always drawn. A tick or select before it is not the row's name. */
export function isIdentityColumn<T>(column: DataColumn<T>): boolean {
  return !column.tier && !column.control;
}

/** A column with no header (the actions column) cannot be named in a menu: never offered, never hidden. */
export function columnMenu<T>(
  columns: DataColumn<T>[],
  visibility: { hidden: string[]; toggle: (id: string) => void },
) {
  const requiredId = columns.find((column) => isIdentityColumn(column) && column.header)?.id;
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
  const requiredId = columns.find((column) => isIdentityColumn(column) && column.header)?.id;
  return columns.filter(
    (column) => column.id === requiredId || !column.header || !hidden.includes(column.id),
  );
}
