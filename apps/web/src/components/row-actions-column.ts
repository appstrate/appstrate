// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { DataColumn } from "./data-table";

/**
 * The row's end: its « … » menu (`TableRowActions`). One width for every table,
 * no head (so nothing to drag, hide or list), and a control: never hidden for
 * lack of room, never the row's link.
 */
export function rowActionsColumn<T>(cell: (row: T) => ReactNode): DataColumn<T> {
  return { id: "actions", header: "", width: "48px", align: "end", control: true, cell };
}
