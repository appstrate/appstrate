// SPDX-License-Identifier: Apache-2.0

import type { FilterSpec } from "../components/list-toolbar";

/** Whether the reader filtered: some filter they set (not a screen default) holds a value. */
export function readerFiltered(filters: readonly FilterSpec[]): boolean {
  return filters.some((filter) => !filter.isDefault && filter.values.length > 0);
}

/**
 * Whether a toolbar's filter row is showing. The reader's own toggle (`choice`) wins; until then
 * it is open when something was active at the first render, or when a default holds a value now:
 * a default that appears later (the space filter) must not narrow the list behind a shut row.
 */
export function filterRowOpen(
  choice: boolean | null,
  startedActive: boolean,
  filters: readonly FilterSpec[],
): boolean {
  return choice ?? (startedActive || filters.some((f) => f.isDefault && f.values.length > 0));
}
