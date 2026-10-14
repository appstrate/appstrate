// SPDX-License-Identifier: Apache-2.0

import type { DetailTab } from "../components/detail-tabs";

/** The label of the active tab, for the breadcrumb. */
export function activeTabLabel<T extends string>(tabs: readonly DetailTab<T>[], value: T): string {
  return tabs.find((tab) => tab.value === value)?.label ?? value;
}
