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
   * Per-turn breakdown from `buildTurnRows` — the WHOLE input. Each turn carries
   * its own window, so numerator and denominator arrive together and cannot
   * disagree; `readRunContext` decides which turn's window applies.
   */
  turns: readonly RunTurnRow[] | undefined;
  /**
   * `runs.status`, raw rather than a pre-computed `isActive`, so
   * `ACTIVE_RUN_STATUSES` stays the single definition of the split.
   */
  status: string | null | undefined;
}

/**
 * The run's context occupancy, a peer of the `$` readout in the run-detail
 * header (#1046).
 *
 * Two readings, because the useful question changes when the run stops: active
 * shows the CURRENT context (`128k / 200k · 64 %` — headroom left before
 * auto-compaction), terminal shows the PEAK (`187k / 200k` — did this run come
 * close). Terminal drops the percentage per the issue's sketch but keeps the
 * bar: "how full did it get" reads at a glance where two numbers have to be
 * divided.
 *
 * The two diverge exactly when the runner compacted — a run that peaked at 187k
 * and ended at 40k prints a high-water mark, not a stopping point — so which
 * reading is on screen has to be stated. `aria-valuetext` names it in both
 * states. Sighted users get a tooltip on the TERMINAL state only: that is the
 * misreadable number, and the state that drops the percentage. The active
 * reading is the unsurprising one, and an affordance that says nothing trains
 * people to ignore the one that does.
 *
 * LIVE CADENCE — `contextTokens` exists only at turn boundaries, so the gauge is
 * STILL for a whole turn, then jumps. Do not add polling, animation or
 * interpolation: a smoothly creeping bar would be an invented number, and would
 * hide the compaction drop that is the most informative thing here.
 *
 * NARROW VIEWPORTS — the header must not scroll horizontally at 375px, where it
 * also carries the tab list, the `$` pill and Re-run/Cancel. The gauge is
 * `shrink-0` and drops the bar and the percentage; the counts stay at every
 * width, because #1046 exists precisely because a header hid its primary figures
 * behind a breakpoint. The track collapses to `w-0` and NOT to `hidden`:
 * `display: none` would take the progressbar out of the accessibility tree, and
 * with it the `aria-valuetext` carrying the UNABBREVIATED counts that the
 * visible `128k / 200k` has compacted away.
 *
 * Renders NOTHING (not a zeroed bar) when there are no turns, no turn stating a
 * window, or no turn with a usable reading — see `readRunContext` for all three,
 * and for why a numerator it cannot divide is dropped rather than shown.
 */
export function ContextGaugeReadout({ turns, status }: ContextGaugeReadoutProps) {
  const { t, i18n } = useTranslation("agents");
  const reading = readRunContext(turns);
  if (!reading) return null;

  const isActive = !!status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
  const value = isActive ? reading.current : reading.peak;
  const fraction = isActive ? reading.currentFraction : reading.peakFraction;

  // `aria-valuetext` REPLACES the raw number in every AT announcement, which is
  // why it — and not `aria-valuenow` — is where the reading gets named.
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
      {/* `aria-valuenow` is clamped into `[valuemin, valuemax]`: announcing
          "210000 out of a maximum of 200000" reports a broken widget, not an
          overflowing context. The raw count stays honest in `aria-valuetext`
          and in the visible text — a window recorded at launch can legitimately
          disagree with what the provider later billed. */}
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
            {/* Focusable trigger, wrapping the COUNTS rather than the pill: the
                counts are the ambiguous part, and making the pill the trigger
                would nest the progressbar's own focus stop inside it. Same
                dotted-underline shape as `RunTokensReadout`, so the two readouts
                in this header teach one affordance rather than two. */}
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
 * What the terminal gauge's tooltip says. Exported as a testing affordance, as
 * `RunRowDetails` is: Radix keeps tooltip content unmounted until it is opened
 * and the web test runner has no DOM, so this is the only way to assert the
 * sighted-user carrier of the current/peak distinction without a browser.
 */
export function ContextGaugePeakHint() {
  const { t } = useTranslation("agents");
  return <span className="block text-xs">{t("run.contextGaugePeakHint")}</span>;
}
