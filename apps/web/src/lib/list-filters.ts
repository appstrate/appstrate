// SPDX-License-Identifier: Apache-2.0

import type { FilterSpec } from "../components/list-toolbar";

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/**
 * Whether the reader filtered: some filter holds values other than the screen's own default (the
 * default ticked, or unticked to none, is not a filter the reader set).
 */
export function readerFiltered(filters: readonly FilterSpec[]): boolean {
  return filters.some(
    (filter) => filter.values.length > 0 && !sameValues(filter.values, filter.defaultValues ?? []),
  );
}

/**
 * Whether a toolbar's filter row is showing. The reader's own toggle (`choice`) wins; until then
 * it is open when something was active at the first render, or while a filter carries a screen
 * default, ticked or not: a default that appears later (the space filter) must not narrow the list
 * behind a shut row, nor the row vanish when the reader unticks it.
 */
export function filterRowOpen(
  choice: boolean | null,
  startedActive: boolean,
  filters: readonly FilterSpec[],
): boolean {
  return choice ?? (startedActive || filters.some((f) => f.defaultValues !== undefined));
}
