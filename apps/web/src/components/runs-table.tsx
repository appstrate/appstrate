// SPDX-License-Identifier: Apache-2.0

/**
 * The runs column set — the first consumer of {@link DataTable}.
 *
 * The reference calls it `.dt-runs`: eight columns over the shared table, with
 * the number and the name doing the identifying and the rest reading as
 * columns rather than as a sentence. The row used to be a flex line where
 * every fact floated to wherever the previous one ended, so nothing lined up
 * between rows and the eye had to re-read each one.
 *
 * What the change buys, beyond alignment: a RESULT column. A failed run's
 * error was invisible in the list — you had to open the run to learn what
 * broke, on the very screen whose job is to tell you which one did.
 *
 * A column set is a list of ids, so the four surfaces that show runs (the runs
 * page, an agent's runs tab, a schedule's history, the dashboard's recent
 * card) subtract instead of re-drawing: inside an agent, the agent column says
 * nothing new and goes.
 */

import { useTranslation } from "react-i18next";
import { FileInput, FileOutput } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { DataTable, type DataColumn } from "./data-table";
import { Badge } from "./status-badge";
import { RunTrigger } from "./run-trigger";
import { RunDuration } from "./run-duration";
import { formatDateField } from "../lib/markdown";

type RunColumnId = "num" | "agent" | "status" | "trigger" | "result" | "docs" | "duration" | "date";

/**
 * Every track is content-INDEPENDENT (px or fr), and that is a constraint, not
 * a style: each row is its own grid container, so an `auto` track would be
 * measured per row and the columns would stop lining up — the one thing the
 * table exists to do.
 */
const WIDTHS: Record<RunColumnId, string> = {
  num: "56px",
  agent: "minmax(0,1.3fr)",
  status: "104px",
  trigger: "minmax(0,1fr)",
  result: "minmax(0,1.1fr)",
  docs: "60px",
  duration: "76px",
  date: "132px",
};

/**
 * What survives at 375px: who ran, how it ended, how long it took. The rest
 * drops with its track — a phone has room for the answer, not for the
 * paperwork around it.
 */
const SECONDARY: ReadonlySet<RunColumnId> = new Set<RunColumnId>([
  "num",
  "trigger",
  "result",
  "docs",
  "date",
]);

/** The column set, in order. */
const RUN_COLUMNS: readonly RunColumnId[] = [
  "num",
  "agent",
  "status",
  "trigger",
  "result",
  "docs",
  "duration",
  "date",
];

function BadgeText({ label, title, italic }: { label: string; title?: string; italic?: boolean }) {
  return (
    <span
      title={title}
      className={`border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${
        italic ? "italic" : ""
      }`}
    >
      {label}
    </span>
  );
}

export function RunsTable({
  runs,
  hideAgentName = false,
  agentName,
  isLoading,
  empty,
  banner,
}: {
  runs: EnrichedRun[];
  /**
   * Inside an agent — or a schedule, which fixes one — the agent column repeats
   * the page title on every row. The set subtracts it; the table grows no
   * special case.
   */
  hideAgentName?: boolean;
  /** Resolves the display name of the agent a run executed. */
  agentName: (run: EnrichedRun) => string | undefined;
  isLoading?: boolean;
  empty?: React.ReactNode;
  banner?: React.ReactNode;
}) {
  const { t } = useTranslation(["agents"]);

  const cells: Record<RunColumnId, (run: EnrichedRun) => React.ReactNode> = {
    num: (run) =>
      run.runNumber == null ? null : (
        <span className="text-muted-foreground font-mono text-xs">#{run.runNumber}</span>
      ),
    agent: (run) => {
      const name = agentName(run);
      // `packageId == null` on a non-inline run means the source agent was
      // deleted (FK SET NULL): the run survives, its agent page does not.
      const isOrphaned = run.packageId == null && run.package_ephemeral !== true;
      return (
        <>
          {name && <span className="truncate font-medium">{name}</span>}
          {run.package_ephemeral === true && <BadgeText label={t("runs.inlineBadge")} />}
          {isOrphaned && (
            <BadgeText
              label={t("runs.deletedAgentBadge")}
              title={t("runs.deletedAgentTitle")}
              italic
            />
          )}
          {run.runOrigin === "remote" && (
            <BadgeText label={t("runs.remoteBadge")} title={t("runs.remoteBadgeTitle")} />
          )}
        </>
      );
    },
    status: (run) => <Badge status={run.status} compact unread={run.unread} />,
    trigger: (run) => <RunTrigger run={run} />,
    result: (run) =>
      run.error ? (
        <span className="text-destructive truncate font-mono text-xs" title={run.error}>
          {run.error}
        </span>
      ) : (
        <span className="text-muted-foreground/50">—</span>
      ),
    docs: (run) => {
      const { input, output } = run.document_counts;
      if (!input && !output) return null;
      return (
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {input > 0 && (
            <span
              className="flex items-center gap-0.5"
              title={t("run.inputDocuments", { count: input })}
            >
              <FileInput size={12} className="shrink-0" />
              {input}
            </span>
          )}
          {output > 0 && (
            <span
              className="flex items-center gap-0.5"
              title={t("run.outputDocuments", { count: output })}
            >
              <FileOutput size={12} className="shrink-0" />
              {output}
            </span>
          )}
        </span>
      );
    },
    duration: (run) => (
      <RunDuration status={run.status} startedAt={run.started_at} duration={run.duration} />
    ),
    date: (run) => (
      <span className="text-muted-foreground truncate text-xs">
        {run.started_at ? formatDateField(run.started_at) : ""}
      </span>
    ),
  };

  const cols: DataColumn<EnrichedRun>[] = RUN_COLUMNS.filter(
    (id) => !(hideAgentName && id === "agent"),
  ).map((id) => ({
    id,
    header: t(`runs.column.${id}`),
    width: WIDTHS[id],
    align: id === "duration" || id === "date" ? "end" : undefined,
    secondary: SECONDARY.has(id),
    cell: cells[id],
  }));

  return (
    <DataTable
      label={t("runs.tableLabel")}
      columns={cols}
      rows={runs}
      isLoading={isLoading}
      empty={empty}
      banner={banner}
      rowKey={(run) => run.id}
      // A deleted agent has no agent page, so `/agents/:packageId/runs/:id`
      // would 404: that row stays static rather than leading nowhere.
      rowHref={(run) =>
        run.packageId == null ? undefined : `/agents/${run.packageId}/runs/${run.id}`
      }
      rowLabel={(run) =>
        t("runs.rowLabel", { number: run.runNumber ?? "?", agent: agentName(run) ?? "" })
      }
      rowState={(run) => ({ runNumber: run.runNumber })}
    />
  );
}
