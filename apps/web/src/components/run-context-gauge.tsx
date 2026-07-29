// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ACTIVE_RUN_STATUSES } from "@appstrate/shared-types";
import type { RunTurnRow } from "./log-utils";
import { formatCompactTokens, formatWindowPercent, readRunContext } from "./run-context";

interface ContextGaugeReadoutProps {
  /** Per-turn breakdown projected from the run's logs (`buildTurnRows`). */
  turns: readonly RunTurnRow[] | undefined;
  /** `runs.context_window` — the denominator. `null` renders nothing. */
  contextWindow: number | null | undefined;
  /** `runs.compaction_threshold` — the marker. `null` drops the marker only. */
  compactionThreshold: number | null | undefined;
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
 *   - active   → `ctx  ▓▓▓▓░░  128k / 200k · 64 %` — the CURRENT context, i.e.
 *                how much headroom is left before auto-compaction.
 *   - terminal → `pic ctx  ▓▓▓▓▓░  187k / 200k`   — the PEAK, i.e. the
 *                post-mortem "did this run come close to compaction".
 *
 * The bar is kept in the terminal form even though the issue's sketch shows
 * text only: the threshold marker is the whole point of the post-mortem
 * reading, and a marker needs a track to sit on. The percentage is dropped
 * there, per that sketch — a peak share is a diagnostic, and the two absolute
 * figures beside it already carry it.
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
 * that is the only carrier of the compaction threshold for a screen-reader or
 * touch user — i.e. it would drop the threshold for exactly the people it was
 * just given to. A zero-width track costs nothing to lay out and stays
 * announced; only the decoration inside it is clipped.
 *
 * Renders NOTHING (not a zeroed bar) when the run has no turns, no window, or
 * no turn with a usable reading — see `readRunContext` for all three cases and
 * why the header drops a numerator it cannot divide.
 */
export function ContextGaugeReadout({
  turns,
  contextWindow,
  compactionThreshold,
  status,
}: ContextGaugeReadoutProps) {
  const { t, i18n } = useTranslation("agents");
  const reading = readRunContext(turns, contextWindow, compactionThreshold);
  if (!reading) return null;

  const isActive = !!status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
  const value = isActive ? reading.current : reading.peak;
  const fraction = isActive ? reading.currentFraction : reading.peakFraction;
  const thresholdLabel =
    reading.threshold == null
      ? null
      : t("run.contextGaugeThreshold", { tokens: formatCompactTokens(reading.threshold) });

  // `aria-valuenow` MUST stay inside `[valuemin, valuemax]` — a screen reader
  // announcing "210000 out of a maximum of 200000" is reporting a broken widget,
  // not an overflowing context. The raw count is not lost: it is what
  // `aria-valuetext` and the visible text carry, unclamped, exactly as
  // `readRunContext` leaves it (a window recorded at launch can legitimately
  // disagree with what the provider later billed).
  const ariaValueText = [
    t("run.contextGaugeValueText", {
      used: value.toLocaleString(i18n.language),
      window: reading.window.toLocaleString(i18n.language),
    }),
    thresholdLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="text-muted-foreground bg-muted/50 flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs tabular-nums">
      <span>{isActive ? t("run.contextGaugeLabel") : t("run.contextGaugePeakLabel")}</span>
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
        {reading.thresholdFraction != null && (
          // A 1px hairline was reachable by nothing but a precise mouse. The
          // visible mark stays thin (it must read as a line on the track, not as
          // a second fill) but sits centred in a wider transparent target, and
          // `title` is no longer the only carrier of what it means — the
          // threshold is folded into `aria-valuetext` above, which is what a
          // screen-reader and a touch user actually get.
          <span
            aria-hidden
            title={thresholdLabel ?? undefined}
            className="absolute inset-y-0 flex w-2 -translate-x-1/2 justify-center"
            style={{ left: `${reading.thresholdFraction * 100}%` }}
          >
            <span className="bg-foreground/70 h-full w-0.5" />
          </span>
        )}
      </span>
      <span className="text-foreground font-medium">
        {formatCompactTokens(value)} / {formatCompactTokens(reading.window)}
      </span>
      {isActive && (
        <span className="hidden sm:inline">· {formatWindowPercent(fraction, i18n.language)}</span>
      )}
    </div>
  );
}
