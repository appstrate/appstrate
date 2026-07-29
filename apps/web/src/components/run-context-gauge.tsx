// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { ACTIVE_RUN_STATUSES } from "@appstrate/shared-types";
import type { RunTurnRow } from "./log-utils";
import { formatCompactTokens, formatWindowPercent, readRunContext } from "./run-context";

interface ContextGaugeReadoutProps {
  /**
   * Per-turn breakdown projected from the run's logs (`buildTurnRows`) — the
   * WHOLE input. Each turn carries its own window, so the numerator and the
   * denominator arrive together and cannot disagree; see `readRunContext` for
   * which turn's window is used.
   */
  turns: readonly RunTurnRow[] | undefined;
  /**
   * `runs.status`. Taken raw rather than as a pre-computed `isActive` boolean so
   * the active/terminal vocabulary has exactly one definition
   * (`ACTIVE_RUN_STATUSES`) and the caller cannot disagree with the gauge about
   * which reading a run gets.
   */
  status: string | null | undefined;
}

/**
 * The run's context occupancy, as a peer of the `$` readout in the run-detail
 * header — same chrome, same weight, not a hero element.
 *
 * Two readings of the same series, because the useful question changes when the
 * run stops (#1046):
 *   - active   → `▓▓▓▓░░  128k / 200k · 64 %` — the CURRENT context, i.e. how
 *                much headroom is left before auto-compaction.
 *   - terminal → `▓▓▓▓▓░  187k / 200k`        — the PEAK, i.e. the post-mortem
 *                "did this run come close to compaction".
 *
 * The bar is kept in the terminal form even though the issue's sketch shows
 * text only: "how close to full did it get" is the post-mortem reading, and a
 * fill answers it at a glance where two numbers have to be divided. The
 * percentage is dropped there, per that sketch — a peak share is a diagnostic,
 * and the two absolute figures beside it already carry it.
 *
 * WHICH READING, AND HOW IT IS SIGNALLED — the two diverge exactly when the
 * runner compacted: a run that peaked at 187k and ended at 40k prints `187k`,
 * which is a high-water mark and not a stopping point. That distinction used to
 * ride a permanent `ctx` / `pic ctx` text prefix. It no longer does: a label on
 * every render is a heavy way to carry a fact that only surprises in one of the
 * two states, and the bar plus `128k / 200k` is otherwise self-describing.
 * It is carried instead by
 *   - `aria-valuetext`, which NAMES the reading on both states. It is the AT
 *     path and it costs no pixels, so there is no reason to make it selective.
 *   - a tooltip, on the TERMINAL state only.
 *
 * Two judgement calls behind that tooltip, both deliberate:
 *
 *  1. It wraps the COUNTS, not the whole pill. The counts are the ambiguous
 *     part; the bar already carries its own accessible name and `aria-valuetext`
 *     and would become a focus stop nested inside an interactive trigger if the
 *     pill were the trigger. It is also the shape `RunTokensReadout` uses one
 *     element over — same dotted-underline trigger, same `tabIndex={0}`, so the
 *     two readouts in this header teach the reader one affordance, not two.
 *     `title=` is deliberately NOT used: it is invisible to touch and to screen
 *     readers, which is the whole failure this replaces.
 *
 *  2. The ACTIVE state gets no tooltip. Its reading is the unsurprising one —
 *     a running run has no "final" figure a live number could be mistaken for,
 *     the bar is visibly moving, and the percentage that only the active state
 *     renders already anchors the number as a share of the window RIGHT NOW.
 *     A tooltip there would restate the screen, and an affordance that says
 *     nothing trains people to ignore the one that does. The terminal state is
 *     precisely the one that drops the percentage, i.e. the one with the least
 *     on-screen context and the only misreadable number.
 *
 * LIVE CADENCE — `contextTokens` only exists at turn boundaries: the runner
 * emits one breadcrumb per settled assistant turn, and the per-run SSE stream
 * patches those rows into the same React Query cache `turns` is projected from.
 * So the gauge is intentionally STILL for the whole duration of a long turn,
 * then jumps. That is the truth of the measurement. Do not add polling,
 * animation or interpolation to make it look continuous — a smoothly creeping
 * bar would be an invented number, and it would also hide the compaction drop
 * that is the single most informative thing this gauge shows.
 *
 * NARROW VIEWPORTS — the header row must not scroll horizontally at 375px
 * (#1046), where it also carries the tab list, the `$` pill and Re-run/Cancel.
 * The gauge is `shrink-0` (a squeezed token count is worse than none) and drops
 * the two parts that carry nothing the rest does not: the bar, whose numbers sit
 * beside it, and the percentage, which is `used / window` restated. The counts
 * themselves are kept at every width — they ARE the reading, and #1046 exists
 * because a header hid its primary figures behind a breakpoint.
 *
 * The track collapses to `w-0`, NOT to `hidden`: `display: none` would take the
 * `progressbar` out of the accessibility tree, and with it the `aria-valuetext`
 * that is the only carrier of the UNABBREVIATED counts — the visible text is
 * compacted to `128k / 200k` at every width. A zero-width track costs nothing to
 * lay out and stays announced; only the fill inside it is clipped.
 *
 * Renders NOTHING (not a zeroed bar) when the run has no turns, no turn stating
 * a window, or no turn with a usable reading — see `readRunContext` for all
 * three cases and why the header drops a numerator it cannot divide. All three
 * are now read from the same rows, so a run whose logs were pruned drops the
 * gauge whole instead of keeping a denominator with nothing left to divide.
 */
export function ContextGaugeReadout({ turns, status }: ContextGaugeReadoutProps) {
  const { t, i18n } = useTranslation("agents");
  const reading = readRunContext(turns);
  if (!reading) return null;

  const isActive = !!status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
  const value = isActive ? reading.current : reading.peak;
  const fraction = isActive ? reading.currentFraction : reading.peakFraction;

  // `aria-valuenow` MUST stay inside `[valuemin, valuemax]` — a screen reader
  // announcing "210000 out of a maximum of 200000" is reporting a broken widget,
  // not an overflowing context. The raw count is not lost: it is what
  // `aria-valuetext` and the visible text carry, unclamped, exactly as
  // `readRunContext` leaves it (a window recorded at launch can legitimately
  // disagree with what the provider later billed).
  //
  // It also NAMES the reading (current vs peak), which the removed text prefix
  // used to do for everyone: `aria-valuetext` REPLACES the raw number in every
  // AT announcement, so naming it there costs nothing and keeps the distinction
  // on the assistive path in both states — including the active one, which
  // renders no tooltip.
  const ariaValueText = t(
    isActive ? "run.contextGaugeValueText" : "run.contextGaugePeakValueText",
    {
      used: value.toLocaleString(i18n.language),
      window: reading.window.toLocaleString(i18n.language),
    },
  );

  const counts = `${formatCompactTokens(value)} / ${formatCompactTokens(reading.window)}`;

  return (
    <div className="text-muted-foreground bg-muted/50 flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs tabular-nums">
      {/* The bar carries no meaning the text does not: the counts (and, while
          active, the percentage) sit beside it, and the ARIA values restate the
          same numbers for a reader that skips the decoration. */}
      <span
        role="progressbar"
        aria-label={isActive ? t("run.contextGaugeAria") : t("run.contextGaugePeakAria")}
        aria-valuemin={0}
        aria-valuemax={reading.window}
        aria-valuenow={Math.min(value, reading.window)}
        aria-valuetext={ariaValueText}
        className="bg-muted-foreground/25 relative block h-1.5 w-0 overflow-hidden rounded-full sm:w-14"
      >
        <span
          aria-hidden
          className="bg-primary absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${fraction * 100}%` }}
        />
      </span>
      {isActive ? (
        <span className="text-foreground font-medium">{counts}</span>
      ) : (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            {/* Focusable trigger: the counts are otherwise plain text, so
                keyboard and touch users would have no way to reach the one
                thing the removed label used to state. */}
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="text-foreground cursor-default font-medium underline decoration-dotted"
              >
                {counts}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <ContextGaugePeakHint />
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {isActive && (
        <span className="hidden sm:inline">· {formatWindowPercent(fraction, i18n.language)}</span>
      )}
    </div>
  );
}

/**
 * What the terminal gauge's tooltip says: that the figure is a maximum, and why
 * it can sit far above where the run actually ended.
 *
 * Exported as a testing affordance, exactly as `RunRowDetails` is: Radix keeps
 * tooltip content unmounted until it is opened, and the web test runner has no
 * DOM to open it with — so this is the only way to assert the sighted-user
 * carrier of the current/peak distinction without adding a browser harness.
 */
export function ContextGaugePeakHint() {
  const { t } = useTranslation("agents");
  return <span className="block text-xs">{t("run.contextGaugePeakHint")}</span>;
}
