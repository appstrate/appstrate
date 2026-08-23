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
 * What the Outcome pane is holding, as three independent booleans.
 *
 * Its own type, distinct from {@link RunTabAvailability}, because the two
 * callers know the file half differently: the page has only the run DTO's
 * COUNT, while the pane has resolved rows too. Both collapse to "are there
 * produced files", which is all {@link runHasOutcome} asks.
 */
interface RunOutcomeContent {
  /** The run produced at least one file. */
  hasFiles: boolean;
  /** The `output` tool emitted a value. */
  hasOutput: boolean;
  /** The run wrote or touched at least one memory row. */
  hasMemory: boolean;
}

/**
 * Does this run have an OUTCOME — anything at all for the Outcome pane to show?
 *
 * THE single rule, and it has to be single. Two callers depend on it and they
 * are on opposite sides of the same coin:
 *
 *  - {@link initialRunDetailTab} sends the reader to `outcome` when it is true;
 *  - `run-outcome-tab.tsx` renders «Ce run n'a rien produit» when it is false.
 *
 * Written out twice — as De Morgan duals, in two files — they drifted silently
 * in one direction into "the page opens on a pane that says the run produced
 * nothing", and in the other into "the outcome sits behind an unadvertised
 * click". Neither self-corrects: the tab capture is FROZEN
 * ({@link capturedRunDetailTab}), so a later render cannot walk it back.
 */
export function runHasOutcome({ hasFiles, hasOutput, hasMemory }: RunOutcomeContent): boolean {
  return hasFiles || hasOutput || hasMemory;
}

/**
 * Does an `output` tool value count as present?
 *
 * The run DTO carries `{}` for a run whose tool emitted an empty object, and
 * an empty object is not an outcome — it would open the pane on a card holding
 * `{}`. Exported because the page (feeding {@link RunTabAvailability}) and the
 * pane (rendering the same value) each computed it, over the SAME object the
 * page hands down: two spellings of one predicate, one prop apart.
 */
export function runHasOutputValue(output: Record<string, unknown> | null | undefined): boolean {
  return !!output && Object.keys(output).length > 0;
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
  return runHasOutcome({ hasFiles: producedFileCount > 0, hasOutput, hasMemory })
    ? "outcome"
    : "execution";
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

/**
 * The hash the address bar should be rewritten to, or `undefined` when the URL
 * already carries the canonical one.
 *
 * Rendering the right pane for a retired hash is not enough: the user copies
 * the URL they see, and a dead `#documents` keeps propagating. The rewrite runs
 * from an effect, which is exactly the construct that loops in production, so
 * the decision is pulled out here where its TERMINATION can be tested instead
 * of assumed. It holds because {@link effectiveRunDetailTab} is idempotent —
 * `f(f(x)) === f(x)` for every hash, live or retired — so the rewritten hash is
 * always a fixed point and answers `undefined` on the next pass.
 */
export function runDetailTabHashRewrite(requested: RunDetailTabHash): RunDetailTab | undefined {
  const effective = effectiveRunDetailTab(requested);
  return effective === requested ? undefined : effective;
}

/**
 * The default pane the run-detail tab controller should hold.
 *
 * `null` means "not decided yet" — the controller renders a provisional answer
 * and asks again on the next render. Two rules, and both are load-bearing:
 *
 *  - Once captured, the answer is FROZEN. A file published while the page is
 *    open must not move the user to another tab mid-read, so a non-null
 *    `captured` is returned verbatim and `availability` is not consulted again.
 *  - The capture waits for settled inputs. `hasMemory` rides two persistence
 *    queries that resolve independently of the run, so at first render a run
 *    that only wrote memory still looks like a run that produced nothing, and
 *    capturing then froze it on «Exécution» non-deterministically. `hasOutput`
 *    and `producedFileCount` both ride the run DTO the page already has: when
 *    either says `outcome`, memory cannot change the answer and there is
 *    nothing to wait for — that short-circuit is why a run with an output value
 *    captures immediately rather than blocking on unrelated queries.
 */
export function capturedRunDetailTab(args: {
  /** What this controller has already captured, or `null` if nothing yet. */
  captured: RunDetailTab | null;
  availability: RunTabAvailability;
  /** The memory queries feeding `availability.hasMemory` have answered. */
  memorySettled: boolean;
}): RunDetailTab | null {
  if (args.captured !== null) return args.captured;
  const settled =
    args.memorySettled || args.availability.hasOutput || args.availability.producedFileCount > 0;
  return settled ? initialRunDetailTab(args.availability) : null;
}
