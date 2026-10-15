// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { ACTIVE_RUN_STATUSES } from "@appstrate/shared-types";
import type { RunTurnRow } from "../log-utils";
import { formatCompactTokens, formatWindowPercent, readRunContext } from "../run-context";

/**
 * Context occupancy: active shows the CURRENT context, terminal the PEAK; they diverge when the
 * runner compacted, so `aria-valuetext` names the reading and the terminal one has a tooltip.
 * `contextTokens` exists only at turn boundaries: no interpolation (it would hide the compaction
 * drop). Renders nothing without a truthful reading (`readRunContext`).
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
      {/* `aria-valuenow` is clamped: "210000 out of 200000" announces a broken widget. */}
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

/** Exported for tests: Radix keeps tooltip content unmounted until opened. */
export function ContextGaugePeakHint() {
  const { t } = useTranslation("agents");
  return <span className="block text-xs">{t("run.contextGaugePeakHint")}</span>;
}
