// SPDX-License-Identifier: Apache-2.0

import type { FilterSpec, ScopeSpec } from "../components/list-toolbar";
import { toggleValue } from "./toggle-value";

/** One menu entry: its label, whether it is ticked, and the values a click sends. */
export interface FacetEntry {
  key: string;
  label: string;
  on: boolean;
  next: string[];
}

/**
 * What a facet's trigger names and its menu holds, in order. A filter names its active values
 * only; a scope names what the list shows (`implicit` while untouched), `all` when that is every
 * option, and its menu opens on the entry choosing them all.
 */
export function facetTicks(facet: FilterSpec | ScopeSpec) {
  const scope = "allLabel" in facet ? facet : undefined;
  const ticked = facet.values.length > 0 ? facet.values : (scope?.implicit ?? []);
  const named = facet.options.filter((option) =>
    (scope ? ticked : facet.values).includes(option.value),
  );
  const all = facet.options.every((option) => ticked.includes(option.value));
  const options: FacetEntry[] = facet.options.map((option) => ({
    key: option.value,
    label: option.label,
    on: ticked.includes(option.value),
    next: toggleValue(ticked, option.value),
  }));
  const allEntry: FacetEntry | undefined = scope && {
    key: "*",
    label: scope.allLabel,
    on: all,
    next: facet.options.map((option) => option.value),
  };
  const groups = allEntry ? [[allEntry], options] : [options];
  return { named, all, scope, groups };
}
