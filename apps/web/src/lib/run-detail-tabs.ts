// SPDX-License-Identifier: Apache-2.0

/**
 * The run-detail page's four panes, in reading order. The set is FIXED: every
 * tab renders for every run, so the strip has the same shape whichever run is
 * open, and no deep link can ever land on a pane that is not there.
 *
 *   - `outcome`       — what the run produced: its `output` value, the files it
 *                       produced, the memory it wrote.
 *   - `files`         — every file attached to the run, imported AND produced.
 *   - `execution`     — how it ran: logs, usage, timings, identifiers, inputs.
 *   - `configuration` — how it was set up: agent, version, trigger, connections.
 *
 * The previous set (result / logs / memory / files / info) grew by accretion
 * and mixed those three questions across five panes; two of them appeared and
 * disappeared per run.
 */
export const RUN_DETAIL_TABS = ["outcome", "files", "execution", "configuration"] as const;

export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

/**
 * Tab hashes that no longer exist but are still out there — in bookmarks, in
 * back-history, in a link pasted into an old chat message — mapped to the pane
 * that absorbed them. Nothing is dropped from this table: a hash removed from
 * it stops resolving and silently falls back to the default pane, which is
 * exactly the "my link stopped working" nobody reports.
 *
 *   - `deliverable` was the run's single featured output, and `result` the
 *     `output` tool's value; both are sections of `outcome` now.
 *   - `memory` is a section of `outcome` too — memory is something the run
 *     produced, not something it was configured with.
 *   - `documents` is the file list under its pre-#1177 name.
 *   - `logs` and `info` both described how the run ran; `execution` is the pane
 *     that answers that question, and it owns the logs, the usage figures, the
 *     timings and the identifiers the Info tab used to hold. The handful of
 *     setup facts that moved to `configuration` instead are one click away —
 *     landing on the diagnostics pane is the better default for both hashes.
 */
const RETIRED_TAB_ALIASES = {
  deliverable: "outcome",
  documents: "files",
  result: "outcome",
  memory: "outcome",
  logs: "execution",
  info: "execution",
} as const satisfies Record<string, RunDetailTab>;

type RetiredRunDetailTab = keyof typeof RETIRED_TAB_ALIASES;

/**
 * What the URL hash is allowed to carry: a live tab, or a retired one that
 * still resolves. Accepting the retired value is what keeps an old link on a
 * real pane instead of silently dropping it back to the default.
 */
export type RunDetailTabHash = RunDetailTab | RetiredRunDetailTab;

export const RUN_DETAIL_TAB_HASHES: readonly RunDetailTabHash[] = [
  ...RUN_DETAIL_TABS,
  ...(Object.keys(RETIRED_TAB_ALIASES) as RetiredRunDetailTab[]),
];

export interface RunTabAvailability {
  /**
   * How many files the run PRODUCED. Inputs it merely consumed are not counted
   * and nothing the agent declared takes part — the count is the whole of the
   * derived presentation rule (#1177): 0 features nothing, exactly 1 is
   * featured and opened, several are listed for the user to pick from.
   */
  producedFileCount: number;
  /** The `output` tool emitted a value. */
  hasOutput: boolean;
  /** The run wrote or touched at least one memory row. */
  hasMemory: boolean;
}

/**
 * Select the most useful pane when a run is opened without an explicit hash.
 *
 * Anything the run produced — a file, an output value, a memory write — leads
 * with `outcome`, because that is the question a finished run is opened to
 * answer. A run that produced nothing leads with `execution`, where the logs
 * say why.
 */
export function initialRunDetailTab({
  producedFileCount,
  hasOutput,
  hasMemory,
}: RunTabAvailability): RunDetailTab {
  if (producedFileCount > 0 || hasOutput || hasMemory) return "outcome";
  return "execution";
}

/**
 * Map a hash carried by the URL onto the pane that renders it.
 *
 * No clamping any more, and none needed: all four panes render for every run,
 * so a deep link is either a live tab or a retired one this table redirects.
 * The old model gated `result` and `memory` on their content being present and
 * had to bounce those hashes to the logs when it was not — a redirect the user
 * could not tell apart from a broken link.
 */
export function effectiveRunDetailTab(requested: RunDetailTabHash): RunDetailTab {
  if (requested in RETIRED_TAB_ALIASES) {
    return RETIRED_TAB_ALIASES[requested as RetiredRunDetailTab];
  }
  return requested as RunDetailTab;
}
