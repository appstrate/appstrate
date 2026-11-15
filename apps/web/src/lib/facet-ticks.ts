// SPDX-License-Identifier: Apache-2.0

import type { FilterSpec } from "../components/list-toolbar";

/**
 * What the menu ticks (`implicit` while untouched), what the trigger names (the active values
 * only) and whether « Tout sélectionner » still has something to add.
 */
export function facetTicks(filter: FilterSpec) {
  const ticked = filter.values.length > 0 ? filter.values : (filter.implicit ?? []);
  const selected = filter.options.filter((option) => filter.values.includes(option.value));
  const offerAll =
    !!filter.selectAll && filter.options.some((option) => !ticked.includes(option.value));
  return { ticked, selected, offerAll };
}
