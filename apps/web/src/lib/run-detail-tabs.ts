// SPDX-License-Identifier: Apache-2.0

export const RUN_DETAIL_TABS = ["overview", "journal", "results"] as const;

export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

export interface RunTabAvailability {
  isActive: boolean;
  isFailed: boolean;
  hasResults: boolean;
}

/** Select the primary task for the current lifecycle state. */
export function initialRunDetailTab({
  isActive: _isActive,
  isFailed: _isFailed,
  hasResults: _hasResults,
}: RunTabAvailability): RunDetailTab {
  return "overview";
}

/**
 * Both destinations remain addressable throughout the lifecycle. Results owns
 * its pending and empty states, so a stable URL never silently returns to the
 * Journal merely because production is not available yet.
 */
export function effectiveRunDetailTab(
  requested: RunDetailTab,
  _availability: RunTabAvailability,
): RunDetailTab {
  return requested;
}
