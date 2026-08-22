// SPDX-License-Identifier: Apache-2.0

export const RUN_DETAIL_TABS = ["result", "logs", "memory", "files", "info"] as const;

export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

/**
 * Tab hashes that no longer exist but are still out there — in bookmarks, in
 * back-history, in a link someone pasted — mapped to the pane that replaced
 * them. `deliverable` was the run's single featured output; the file list now
 * features it (#1177), so that is where an old deep link lands. `documents` is
 * that same list under its pre-#1177 name.
 */
const RETIRED_TAB_ALIASES = { deliverable: "files", documents: "files" } as const satisfies Record<
  string,
  RunDetailTab
>;

type RetiredRunDetailTab = keyof typeof RETIRED_TAB_ALIASES;

/**
 * What the URL hash is allowed to carry: a live tab, or a retired one that
 * still resolves. Accepting the retired value is what keeps an old link on a
 * real pane instead of silently dropping it back to the default.
 */
type RunDetailTabHash = RunDetailTab | RetiredRunDetailTab;

export const RUN_DETAIL_TAB_HASHES: readonly RunDetailTabHash[] = [
  ...RUN_DETAIL_TABS,
  ...(Object.keys(RETIRED_TAB_ALIASES) as RetiredRunDetailTab[]),
];

export interface RunTabAvailability {
  /**
   * The run produced exactly ONE file. Derived client-side from the count of
   * produced files (#1177) — no agent-declared "primary" — and the reason the
   * file list leads: one file is a result the page should show, several are a
   * list the user picks from.
   */
  hasFeaturedFile: boolean;
  hasResult: boolean;
  hasMemory: boolean;
}

/** Select the most useful page when a run is opened without an explicit hash. */
export function initialRunDetailTab({
  hasFeaturedFile,
  hasResult,
}: RunTabAvailability): RunDetailTab {
  if (hasFeaturedFile) return "files";
  if (hasResult) return "result";
  return "logs";
}

/**
 * Keep explicit deep links in the URL but avoid rendering a blank pane while
 * their optional content is unavailable. If realtime data later makes that
 * content available, the bookmarked choice becomes visible automatically.
 *
 * A retired hash is redirected to its successor rather than clamped to the
 * default: `files` is rendered unconditionally, so the redirect always
 * lands on a real pane.
 */
export function effectiveRunDetailTab(
  requested: RunDetailTabHash,
  availability: RunTabAvailability,
): RunDetailTab {
  if (requested in RETIRED_TAB_ALIASES) {
    return RETIRED_TAB_ALIASES[requested as RetiredRunDetailTab];
  }
  const tab = requested as RunDetailTab;
  if (tab === "result" && !availability.hasResult) return "logs";
  if (tab === "memory" && !availability.hasMemory) return "logs";
  return tab;
}
