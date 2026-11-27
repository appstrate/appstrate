// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Progress } from "@appstrate/ui/components/progress";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { ACTIVE_RUN_STATUSES } from "@appstrate/shared-types";
import type { RunTurnRow } from "../log-utils";
import {
  formatCompactTokens,
  formatTokenFigure,
  formatWindowPercent,
} from "@appstrate/ui/context-window";
import { readRunContext } from "../run-context";

/**
 * Context occupancy: active shows the CURRENT context, terminal the PEAK; they diverge when the
 * runner summarized, so `aria-valuetext` names the reading and the terminal one has a popover (a
 * touch screen opens it, unlike a tooltip); so does a window the runner assumed (`≈`), which the
 * value text names too.
 * `contextTokens` exists only at turn boundaries: no interpolation (it would hide the drop a
 * summary causes). Renders nothing without a truthful reading (`readRunContext`).
 */
export function ContextGaugeReadout({
  turns,
  status,
}: {
  turns: readonly RunTurnRow[];
  status: string;
}) {
  const { t, i18n } = useTranslation("agents");
  const reading = readRunContext(turns);
  if (!reading) return null;

  const isActive = (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
  const value = isActive ? reading.current : reading.peak;
  const fraction = isActive ? reading.currentFraction : reading.peakFraction;
  const counts = t("run.contextGaugeCounts", {
    used: formatCompactTokens(value, i18n.language),
    window: formatTokenFigure(reading.window, reading.windowAssumed, i18n.language),
  });

  const windowHint = reading.windowAssumed
    ? t("run.contextGaugeWindowAssumed", {
        window: formatCompactTokens(reading.window, i18n.language),
      })
    : null;
  const valueText = t(isActive ? "run.contextGaugeValueText" : "run.contextGaugePeakValueText", {
    used: value.toLocaleString(i18n.language),
    window: reading.window.toLocaleString(i18n.language),
  });
  const share = isActive ? ` · ${formatWindowPercent(fraction, i18n.language)}` : "";

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums">
      {/* `value` is clamped: "210000 out of 200000" announces a broken widget. */}
      <Progress
        value={Math.min(value, reading.window)}
        max={reading.window}
        aria-label={isActive ? t("run.contextGaugeAria") : t("run.contextGaugePeakAria")}
        aria-valuetext={
          windowHint
            ? t("run.contextGaugeValueTextWithHint", { value: valueText, hint: windowHint })
            : valueText
        }
        className="bg-muted-foreground/25 h-1.5 w-14 shrink-0"
      />
      {isActive && !windowHint ? (
        <span>
          {counts}
          {share}
        </span>
      ) : (
        <Popover>
          <PopoverTrigger
            render={<button type="button" className="cursor-pointer underline decoration-dotted" />}
          >
            {counts}
            {share}
          </PopoverTrigger>
          <PopoverContent side="bottom" className="flex w-auto max-w-xs flex-col gap-1 p-3">
            {isActive ? null : <ContextGaugePeakHint />}
            {windowHint ? <span className="block text-xs">{windowHint}</span> : null}
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}

/** Exported for tests: Radix keeps tooltip content unmounted until opened. */
export function ContextGaugePeakHint() {
  const { t } = useTranslation("agents");
  return <span className="block text-xs">{t("run.contextGaugePeakHint")}</span>;
}
