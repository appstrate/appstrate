// SPDX-License-Identifier: Apache-2.0

import { urlListParams, useListParams } from "../lib/list-params";

/**
 * The tab of a collection split (`CollectionTabs`), kept in `?<name>=`. The first option is the
 * default and leaves the URL; a switch is pushed, so Back undoes it like a detail page's tab.
 */
export function queryTab<T extends string>(
  list: ReturnType<typeof urlListParams>,
  name: string,
  options: readonly [T, ...T[]],
): [T, (tab: T) => void] {
  return [
    list.values(name, options)[0] ?? options[0],
    (tab) => list.setValues(name)(tab === options[0] ? [] : [tab]),
  ];
}

export function useQueryTab<T extends string>(
  name: string,
  options: readonly [T, ...T[]],
): [T, (tab: T) => void] {
  return queryTab(useListParams([]), name, options);
}
