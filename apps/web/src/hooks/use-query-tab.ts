// SPDX-License-Identifier: Apache-2.0

import { urlListParams, useListParams } from "../lib/list-params";

/**
 * The tab of a collection split (`CollectionTabs`), kept in `?<name>=`. The first option is the
 * default and leaves the URL; a switch is pushed, so Back undoes it like a detail page's tab.
 * `current` is the tab the URL holds right now (see {@link useQueryTab}): re-selecting it pushes nothing.
 */
export function queryTab<T extends string>(
  list: ReturnType<typeof urlListParams>,
  name: string,
  options: readonly [T, ...T[]],
  current: () => string | null = () => list.params.get(name),
): [T, (tab: T) => void] {
  return [
    list.values(name, options)[0] ?? options[0],
    (tab) => {
      const next = tab === options[0] ? null : tab;
      if (current() === next) return;
      list.setValues(name)(next === null ? [] : [next]);
    },
  ];
}

export function useQueryTab<T extends string>(
  name: string,
  options: readonly [T, ...T[]],
): [T, (tab: T) => void] {
  // A tab press activates twice (on focus during pointer-down, then on click) before React
  // re-renders: the guard reads the live URL, or the second identical push would leave Back on the same tab.
  return queryTab(useListParams([]), name, options, () =>
    new URLSearchParams(window.location.search).get(name),
  );
}
