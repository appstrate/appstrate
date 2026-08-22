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
 * The set is ONE array of column literals. Widths, breakpoint behaviour,
 * alignment and content sit together per column, so adding one is one edit
 * rather than the same key typed into five parallel maps.
 *
 * Every track is content-INDEPENDENT (px or fr), and that is a constraint, not
 * a style: each row is its own grid container, so an `auto` track would be
 * measured per row and the columns would stop lining up — the one thing the
 * table exists to do.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FileInput, FileOutput, PlayCircle, Shield } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { DataTable, type DataColumn } from "./data-table";
import { Badge, MetaBadge } from "./status-badge";
import { RunTrigger } from "./run-trigger";
import { RunDuration } from "./run-duration";
import { EmptyState } from "./page-states";
import { formatDateField } from "../lib/markdown";

function DocumentCounts({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation(["agents"]);
  const { input, output } = run.document_counts;
  if (!input && !output) return null;
  return (
    // `relative z-10`: these carry a `title`, and the row's link overlay would
    // otherwise take the hover with the click (see `data-table.tsx`).
    <span className="text-muted-foreground relative z-10 flex items-center gap-1.5 text-xs">
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
}

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
          {run.package_ephemeral === true && <MetaBadge label={t("runs.inlineBadge")} />}
          {/* `packageId == null` on a non-inline run means the source agent was
              deleted (FK SET NULL): the run survives, its agent page does not. */}
          {run.packageId == null && run.package_ephemeral !== true && (
            <MetaBadge
              label={t("runs.deletedAgentBadge")}
              title={t("runs.deletedAgentTitle")}
              italic
            />
          )}
          {run.runOrigin === "remote" && (
            <MetaBadge label={t("runs.remoteBadge")} title={t("runs.remoteBadgeTitle")} />
          )}
        </>
      ),
    },
    {
      id: "status",
      header: t("runs.column.status"),
      width: "104px",
      cell: (run) => <Badge status={run.status} compact unread={run.unread} />,
    },
    {
      id: "trigger",
      header: t("runs.column.trigger"),
      width: "minmax(80px,0.8fr)",
      tier: 3,
      cell: (run) => (
        <>
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
      cell: (run) =>
        run.error ? (
          <span
            className="text-destructive relative z-10 truncate font-mono text-xs"
            title={run.error}
          >
            {run.error}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
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
      cell: (run) => (
        <span className="text-muted-foreground truncate text-xs">
          {run.started_at ? formatDateField(run.started_at) : ""}
        </span>
      ),
    },
  ];

  return hideAgentName ? columns.filter((c) => c.id !== "agent") : columns;
}

export function RunsTable({
  runs,
  columns,
  agentName,
  isLoading,
  isError,
  error,
  empty,
  banner,
}: {
  runs: EnrichedRun[];
  /** From {@link useRunColumns}, minus whatever the reader hid. */
  columns: DataColumn<EnrichedRun>[];
  agentName: (run: EnrichedRun) => string;
  isLoading?: boolean;
  /** The request failed — which is not the same thing as an empty list. */
  isError?: boolean;
  /** Says WHY it failed. `DataTable` draws a default when no caller does. */
  error?: ReactNode;
  /** Replaces the default "no runs" state, for a surface that can say more. */
  empty?: ReactNode;
  /** Pinned above the first row (e.g. a scheduled next run). */
  banner?: ReactNode;
}) {
  const { t } = useTranslation(["agents"]);

  return (
    <DataTable
      label={t("runs.tableLabel")}
      columns={columns}
      rows={runs}
      isLoading={isLoading}
      // A failed request is NOT an empty list — the lab's `error` scenario is
      // what showed it, with `GET /api/runs` answering 500 and the page saying
      // "Aucun run". The two travel as separate props now, so no caller can
      // fold one into the other again.
      isError={isError}
      error={error}
      empty={empty ?? <EmptyState message={t("detail.emptyRuns")} icon={PlayCircle} compact />}
      banner={banner}
      rowKey={(run) => run.id}
      // A deleted agent has no agent page, so `/agents/:packageId/runs/:id`
      // would 404: that row stays static rather than leading nowhere.
      rowHref={(run) =>
        run.packageId == null ? undefined : `/agents/${run.packageId}/runs/${run.id}`
      }
      rowLabel={(run) =>
        t("runs.rowLabel", { number: run.runNumber ?? "?", agent: agentName(run) })
      }
      rowState={(run) => ({ runNumber: run.runNumber })}
    />
  );
}
