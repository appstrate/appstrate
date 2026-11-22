// SPDX-License-Identifier: Apache-2.0

import type { FilterSpec } from "../components/list-toolbar";

/** Whether the reader filtered: some filter they set (not a screen default) holds a value. */
export function readerFiltered(filters: readonly FilterSpec[]): boolean {
  return filters.some((filter) => !filter.isDefault && filter.values.length > 0);
}
