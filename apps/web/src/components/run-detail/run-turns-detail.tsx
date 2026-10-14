// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "@appstrate/core/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { fractionOfWindow, formatWindowPercent, readRunContext } from "../run-context";
import type { RunTurnRow } from "../log-utils";
import { formatNumber } from "../../lib/format-number";

/**
 * Per-turn breakdown. Totals alone hide WHERE a run started re-reading its
 * whole context, which is what makes a long run expensive — this shows the
 * trend, turn by turn.
 *
 * A table, not a chart: the shape is small, the numbers are the point, and no
 * charting dependency is worth it. The proportional bar behind the context
 * column is pure CSS.
 *
 * The bar is normalized on the run's context WINDOW, not on the run's own peak:
 * peak-relative bars make every run look equally full — the widest bar is
 * always 100 % whether the run used 5 % or 95 % of what it was given, which is
 * the one thing the column exists to tell apart.
 *
 * FALLBACK, deliberately explicit: when no turn states a window there is no
 * denominator, so the bar reverts to peak-relative AND the `%` column is not
 * rendered at all. No 200k default is invented here — the runner already
 * applies its own default when it has one, so an absent window means genuinely
 * unknown, and a fabricated percentage is worse than none.
 *
 * That switch is ANNOUNCED, in words and in colour: a full-width bar on the
 * peak turn under an unchanged header would read as "this turn filled the
 * window". The missing `%` column is not a cue: absence never is.
 */
function TurnsTable({ turns }: { turns: RunTurnRow[] }) {
  const { t, i18n } = useTranslation("agents");
  const peak = turns.reduce((max, turn) => Math.max(max, turn.contextTokens), 0);
  // The window comes from the turns through `readRunContext`, which decides
  // which turn's window applies. The table falls back whenever it returns
  // nothing, including on a run whose turns all measured zero: that fallback is
  // announced below, so the reader is never left guessing which denominator
  // they are looking at.
  const contextWindow = readRunContext(turns)?.window ?? null;
  // The denominator the bar is drawn against — the window when known, the run's
  // own peak otherwise. `hasWindow` is what gates the `%` column: a share of a
  // peak is not a share of anything the reader can act on.
  const hasWindow = contextWindow != null && contextWindow > 0;
  const denominator = hasWindow ? contextWindow : peak;

  return (
    <>
      {/* Dense metrics grid, so every cell trims the design system's default
          padding — the components are still what defines the table's structure,
          borders and hover behaviour. */}
      <Table className="border-collapse">
        <TableHeader>
          <TableRow className="text-muted-foreground text-xs hover:bg-transparent">
            <TableHead scope="col" className="h-auto px-0 py-1.5 pr-3">
              {t("run.turnIndex")}
            </TableHead>
            <TableHead scope="col" className="h-auto px-0 py-1.5 pr-3 text-right">
              {t("run.turnContextTokens")}
            </TableHead>
            {hasWindow && (
              <TableHead scope="col" className="h-auto px-0 py-1.5 pr-3 text-right">
                {t("run.turnContextShare")}
              </TableHead>
            )}
            <TableHead scope="col" className="h-auto px-0 py-1.5 pr-3 text-right">
              {t("run.turnOutputTokens")}
            </TableHead>
            <TableHead scope="col" className="h-auto px-0 py-1.5 text-right">
              {t("run.turnLatency")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {turns.map((turn) => {
            const fraction = fractionOfWindow(turn.contextTokens, denominator);
            return (
              <TableRow key={turn.index} className="border-border/40">
                <TableHead
                  scope="row"
                  className="text-foreground h-auto px-0 py-1 pr-3 font-normal tabular-nums"
                >
                  {turn.index}
                </TableHead>
                <TableCell className="relative px-0 py-1 pr-3 text-right tabular-nums">
                  {/* Tinted by what the bar is measured against, so the two
                    denominators are not the same picture: the accent fill
                    means "share of the model window", the neutral fill means
                    "share of this run's own peak". */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0.5 right-0 rounded-sm",
                      hasWindow ? "bg-primary/15" : "bg-muted-foreground/15",
                    )}
                    style={{ width: `${fraction * 100}%` }}
                  />
                  <span className="relative">{formatNumber(turn.contextTokens)}</span>
                </TableCell>
                {hasWindow && (
                  <TableCell className="text-muted-foreground px-0 py-1 pr-3 text-right tabular-nums">
                    {formatWindowPercent(fraction, i18n.language)}
                  </TableCell>
                )}
                <TableCell className="px-0 py-1 pr-3 text-right tabular-nums">
                  {formatNumber(turn.outputTokens)}
                </TableCell>
                <TableCell className="text-muted-foreground px-0 py-1 text-right tabular-nums">
                  {/* Omitted by the runner when it could not observe the turn's
                    start — an em dash is honest, a 0 would read as instant. */}
                  {turn.latencyMs !== undefined ? formatDuration(turn.latencyMs) : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {!hasWindow && (
        <p className="text-muted-foreground mt-2 text-xs">{t("run.turnsPeakRelativeHint")}</p>
      )}
    </>
  );
}

export function RunTurnsDetail({ turns }: { turns: RunTurnRow[] }) {
  const { t } = useTranslation("agents");
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">{t("run.turnsHint")}</p>
      <TurnsTable turns={turns} />
    </div>
  );
}
