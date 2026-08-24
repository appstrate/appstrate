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
