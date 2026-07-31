// SPDX-License-Identifier: Apache-2.0

export const RUN_DETAIL_TABS = [
  "deliverable",
  "result",
  "logs",
  "memory",
  "documents",
  "info",
] as const;

export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

export interface RunTabAvailability {
  hasDeliverable: boolean;
  hasResult: boolean;
  hasMemory: boolean;
}

/** Select the most useful page when a run is opened without an explicit hash. */
export function initialRunDetailTab({
  hasDeliverable,
  hasResult,
}: RunTabAvailability): RunDetailTab {
  if (hasDeliverable) return "deliverable";
  if (hasResult) return "result";
  return "logs";
}

/**
 * Capture the first default selected from a resolved run and preserve it across
 * subsequent realtime updates. In particular, a late primary document must make
 * its tab available without moving a user who is already reading another tab.
 */
export function preserveInitialRunDetailTab(
  current: RunDetailTab | null,
  runResolved: boolean,
  availability: RunTabAvailability,
): RunDetailTab | null {
  if (current || !runResolved) return current;
  return initialRunDetailTab(availability);
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
  if (requested === "deliverable" && !availability.hasDeliverable) {
    return availability.hasResult ? "result" : "logs";
  }
  if (requested === "result" && !availability.hasResult) return "logs";
  if (requested === "memory" && !availability.hasMemory) return "logs";
  return requested;
}
