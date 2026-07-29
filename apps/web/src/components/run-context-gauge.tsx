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
 * Renders NOTHING (not a zeroed bar) when the run has no turns or no window —
 * see `readRunContext` for both cases and why the header drops a numerator it
 * cannot divide.
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

  return (
    <div className="text-muted-foreground bg-muted/50 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs tabular-nums">
      <span>{isActive ? t("run.contextGaugeLabel") : t("run.contextGaugePeakLabel")}</span>
      {/* The bar carries no meaning the text does not: the counts (and, while
          active, the percentage) sit beside it, and the ARIA values restate the
          same numbers for a reader that skips the decoration. */}
      <span
        role="progressbar"
        aria-label={isActive ? t("run.contextGaugeAria") : t("run.contextGaugePeakAria")}
        aria-valuemin={0}
        aria-valuemax={reading.window}
        aria-valuenow={value}
        className="bg-muted-foreground/25 relative block h-1.5 w-14 overflow-hidden rounded-full"
      >
        <span
          aria-hidden
          className="bg-primary absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${fraction * 100}%` }}
        />
        {reading.thresholdFraction != null && (
          <span
            aria-hidden
            title={t("run.contextGaugeThreshold", {
              tokens: formatCompactTokens(reading.threshold!),
            })}
            className="bg-foreground/70 absolute inset-y-0 w-px"
            style={{ left: `${reading.thresholdFraction * 100}%` }}
          />
        )}
      </span>
      <span className="text-foreground font-medium">
        {formatCompactTokens(value)} / {formatCompactTokens(reading.window)}
      </span>
      {isActive && <span>· {formatWindowPercent(fraction, i18n.language)}</span>}
    </div>
  );
}
