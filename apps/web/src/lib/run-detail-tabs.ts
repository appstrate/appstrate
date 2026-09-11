// SPDX-License-Identifier: Apache-2.0

export const RUN_DETAIL_TABS = ["overview", "journal", "results"] as const;

export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

/**
 * There is no retired-hash table any more.
 *
 * `#deliverable`, `#result`, `#memory`, `#logs`, `#info` and `#documents` were
 * mapped onto the pane that absorbed each of them, and rewritten in the
 * address bar so a copied URL stopped propagating the dead anchor. All six are
 * gone: an unrecognised hash now falls through to the default pane, the same
 * as any other hash this page does not know.
 *
 * That IS a behaviour change for a link someone still holds — a bookmark, a
 * back-history entry, a URL pasted into an old message — and it is silent by
 * nature: the page opens on the default tab and nothing says why. It is the
 * accepted cost of keeping one vocabulary for these anchors, recorded here
 * rather than left to be rediscovered.
 */

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
