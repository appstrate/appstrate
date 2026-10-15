// SPDX-License-Identifier: Apache-2.0

/**
 * The runs column set over {@link DataTable}: eight columns, with the number
 * and the name doing the identifying and the rest reading as columns rather
 * than as a sentence, so facts line up between rows and the eye does not
 * re-read each one.
 *
 * Beyond alignment, a RESULT column: a failed run's error shows in the list,
 * on the very screen whose job is to tell you which run broke, without opening
 * the run.
 *
 * The set is ONE array of column literals. Widths, breakpoint behaviour,
 * alignment and content sit together per column, so adding one is one edit
 * rather than the same key typed into five parallel maps.
 *
 * Every track is content-INDEPENDENT (px or fr), and that is a constraint, not
 * a style: each row is its own grid container, so an `auto` track would be
 * measured per row and the columns would stop lining up — the one thing the
 * table exists to do.
 */

import { useTranslation } from "react-i18next";
import { Shield } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import type { DataColumn } from "./data-table";
import { RunStatusBadge } from "./status-badge";
import { RunTrigger } from "./run-trigger";
import { RunDuration } from "./run-duration";
import { DocumentCounts, RunProvenanceBadges, RunResult } from "./run-cells";
import { CellDate } from "./table-cells";

/**
 * The column set, as a value the caller holds.
 *
 * A hook rather than a constant because every header is translated, and a value
 * the CALLER holds because the toolbar's column menu and the table have to be
 * talking about the same columns — the menu names them, the table draws
 * whatever is left of them.
 */
export function useRunColumns({
  agentName,
  hideAgentName = false,
}: {
  /** What to call the agent a run executed — see `use-run-agent-name.ts`. */
  agentName: (run: EnrichedRun) => string;
  /**
   * Inside an agent — or a schedule, which fixes one — the agent column repeats
   * the page title on every row, so the set drops it. The NAME is still
   * resolved: the row's accessible label is built from it.
   */
  hideAgentName?: boolean;
}): DataColumn<EnrichedRun>[] {
  const { t } = useTranslation(["agents"]);

  const columns: DataColumn<EnrichedRun>[] = [
    {
      id: "num",
      header: t("runs.column.num"),
      width: "56px",
      tier: 2,
      cell: (run) =>
        run.runNumber == null ? null : (
          <span className="text-muted-foreground font-mono text-xs">#{run.runNumber}</span>
        ),
    },
    {
      id: "agent",
      header: t("runs.column.agent"),
      width: "minmax(112px,1.3fr)",
      cell: (run) => (
        <>
          <span className="truncate font-medium">{agentName(run)}</span>
          <RunProvenanceBadges run={run} />
        </>
      ),
    },
    {
      id: "status",
      header: t("runs.column.status"),
      width: "104px",
      cell: (run) => <RunStatusBadge status={run.status} compact unread={run.unread} />,
    },
    {
      id: "trigger",
      header: t("runs.column.trigger"),
      width: "minmax(80px,0.8fr)",
      tier: 3,
      cell: (run) => (
        <>
          {/* Without the agent column, the badges that explain a missing
              Cancel or Re-run sit with the trigger. */}
          {hideAgentName && <RunProvenanceBadges run={run} />}
          <RunTrigger run={run} />
          {/* Which egress the run went through. It sits beside the trigger
              because both answer "how did this run reach the outside" — and it
              is here at all because dropping it was an oversight, not a call. */}
          {run.proxy_label && (
            <Shield
              size={12}
              className="text-muted-foreground relative z-10 shrink-0"
              aria-label={run.proxy_label}
            />
          )}
        </>
      ),
    },
    {
      id: "result",
      header: t("runs.column.result"),
      width: "minmax(120px,1.5fr)",
      tier: 3,
      cell: (run) => <RunResult run={run} />,
    },
    {
      id: "docs",
      header: t("runs.column.docs"),
      width: "60px",
      tier: 3,
      cell: (run) => <DocumentCounts run={run} />,
    },
    {
      id: "duration",
      header: t("runs.column.duration"),
      width: "76px",
      align: "end",
      cell: (run) => (
        <RunDuration status={run.status} startedAt={run.started_at} duration={run.duration} />
      ),
    },
    {
      id: "date",
      header: t("runs.column.date"),
      width: "132px",
      align: "end",
      tier: 2,
      cell: (run) => <CellDate value={run.started_at} />,
    },
  ];

  return hideAgentName ? columns.filter((c) => c.id !== "agent") : columns;
}
