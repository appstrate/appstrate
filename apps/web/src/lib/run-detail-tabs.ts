// SPDX-License-Identifier: Apache-2.0

export const RUN_DETAIL_TABS = ["journal", "results"] as const;

export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

export interface RunTabAvailability {
  isActive: boolean;
  isFailed: boolean;
  hasResults: boolean;
}

/** Select the primary task for the current lifecycle state. */
export function initialRunDetailTab({
  isActive,
  isFailed,
  hasResults,
}: RunTabAvailability): RunDetailTab {
  if (isActive || isFailed) return "journal";
  return hasResults ? "results" : "journal";
}

/**
 * Keep explicit deep links in the URL but avoid rendering a blank pane while
 * their optional content is unavailable. If realtime data later makes that
 * content available, the bookmarked choice becomes visible automatically.
 */
export function effectiveRunDetailTab(
  requested: RunDetailTab,
  availability: RunTabAvailability,
): RunDetailTab {
  if (requested === "results" && !availability.hasResults) {
    return initialRunDetailTab(availability);
  }
  return requested;
}
