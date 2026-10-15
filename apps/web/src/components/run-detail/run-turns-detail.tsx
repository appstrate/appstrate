// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "../../lib/format-duration";
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
 * Per-turn breakdown (a table; the context bar is pure CSS). The bar is normalized on the
 * context WINDOW: peak-relative bars would make every run look equally full.
 * FALLBACK: with no stated window the bar reverts to peak-relative and the `%` column is
 * dropped (no invented 200k default: absent means unknown). The switch is announced in words
 * and colour, since a full-width peak bar would read as "filled the window".
 */
function TurnsTable({ turns }: { turns: RunTurnRow[] }) {
  const { t, i18n } = useTranslation("agents");
  const peak = turns.reduce((max, turn) => Math.max(max, turn.contextTokens), 0);
  // Falls back whenever `readRunContext` returns nothing (incl. all-zero turns).
  const contextWindow = readRunContext(turns)?.window ?? null;
  // `hasWindow` gates the `%` column: a share of a peak is not actionable.
  const hasWindow = contextWindow != null && contextWindow > 0;
  const denominator = hasWindow ? contextWindow : peak;

  return (
    <>
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
                  {/* Accent = share of the model window; neutral = share of the run's own peak. */}
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
                  {/* Omitted when the turn's start was not observed: a 0 would read as instant. */}
                  {turn.latencyMs !== undefined ? formatDuration(turn.latencyMs) : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {!hasWindow && (
        <p className="text-muted-foreground text-xs">{t("run.turnsPeakRelativeHint")}</p>
      )}
    </>
  );
}

export function RunTurnsDetail({ turns }: { turns: RunTurnRow[] }) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{t("run.turnsHint")}</p>
      <TurnsTable turns={turns} />
    </div>
  );
}
