// SPDX-License-Identifier: Apache-2.0

import type { DataColumn } from "../components/data-table";

/**
 * The column that says WHICH row this is: the first one read and always drawn.
 * A tick or a select before it is not the row's name.
 */
export function isIdentityColumn<T>(column: DataColumn<T>): boolean {
  return !column.tier && !column.control;
}

/**
 * The columns a reader may hide, and the menu spec that goes with them.
 *
 * A column with no header cannot be named in a menu (the actions column), so it
 * is never offered — and never hidden either.
 */
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

/** What is left once the reader's hidden columns are taken out. */
export function visibleColumns<T>(columns: DataColumn<T>[], hidden: string[]): DataColumn<T>[] {
  const requiredId = columns.find((column) => isIdentityColumn(column) && column.header)?.id;
  return columns.filter(
    (column) => column.id === requiredId || !column.header || !hidden.includes(column.id),
  );
}
