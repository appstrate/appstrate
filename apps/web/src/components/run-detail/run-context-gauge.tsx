// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { ACTIVE_RUN_STATUSES } from "@appstrate/shared-types";
import type { RunTurnRow } from "../log-utils";
import { formatCompactTokens, formatWindowPercent, readRunContext } from "../run-context";

/**
 * The run's context occupancy, a fact of the overview's Usage card.
 *
 * Two readings, because the useful question changes when the run stops: active
 * shows the CURRENT context (`128k / 200k · 64 %` — headroom left before
 * auto-compaction), terminal shows the PEAK (`187k / 200k` — did this run come
 * close). The two diverge exactly when the runner compacted, so which reading
 * is on screen is stated: `aria-valuetext` names it in both states, and the
 * terminal one, the misreadable number, carries a tooltip.
 *
 * `contextTokens` exists only at turn boundaries, so the gauge is still for a
 * whole turn, then jumps. No interpolation: a creeping bar would be an invented
 * number, and would hide the compaction drop.
 *
 * Renders nothing when there is no truthful reading (`readRunContext`).
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
  const counts = `${formatCompactTokens(value)} / ${formatCompactTokens(reading.window)}`;

  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      {/* `aria-valuenow` is clamped into its range: "210000 out of 200000"
          announces a broken widget. The raw count stays in the text. */}
      <span
        role="progressbar"
        aria-label={isActive ? t("run.contextGaugeAria") : t("run.contextGaugePeakAria")}
        aria-valuemin={0}
        aria-valuemax={reading.window}
        aria-valuenow={Math.min(value, reading.window)}
        aria-valuetext={t(
          isActive ? "run.contextGaugeValueText" : "run.contextGaugePeakValueText",
          {
            used: value.toLocaleString(i18n.language),
            window: reading.window.toLocaleString(i18n.language),
          },
        )}
        className="bg-muted-foreground/25 relative block h-1.5 w-14 overflow-hidden rounded-full"
      >
        <span
          aria-hidden
          className="bg-primary absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${fraction * 100}%` }}
        />
      </span>
      {isActive ? (
        <span>
          {counts} · {formatWindowPercent(fraction, i18n.language)}
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="cursor-default underline decoration-dotted">
              {counts}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <ContextGaugePeakHint />
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * What the terminal gauge's tooltip says. Exported for the tests: Radix keeps
 * tooltip content unmounted until opened and the web test runner has no DOM.
 */
export function ContextGaugePeakHint() {
  const { t } = useTranslation("agents");
  return <span className="block text-xs">{t("run.contextGaugePeakHint")}</span>;
}
