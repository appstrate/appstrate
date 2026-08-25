// SPDX-License-Identifier: Apache-2.0

/**
 * The schedules column set (`dt-sched` in the reference).
 *
 * The card it replaces was a row wearing a card's border: a flex line with the
 * name, some badges and the actor pushed right, plus a dashed strip underneath
 * previewing the next run. Stacked, those made a list where no two rows agreed
 * on where anything was — and the one question a schedule list answers, "when
 * does this fire next", was drawn differently on every row depending on which
 * badges came before it.
 *
 * What the columns say, in order: what it is, how often, whether it is on, when
 * next, when last, and who it runs as.
 */

import { useTranslation } from "react-i18next";
import { Calendar, Loader2 } from "lucide-react";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import { DataTable, type DataColumn } from "./data-table";
import { ScheduleStatusBadge } from "./schedule-status-badge";
import { ActorLabel } from "./actor-label";
import { EmptyState } from "./page-states";
import { formatDateField } from "../lib/markdown";

/** The column set, as a value the caller holds — see `useRunColumns` on why. */
export function useScheduleColumns({
  agentName,
}: {
  /** What to call the agent a schedule fires. */
  agentName: (schedule: EnrichedSchedule) => string;
}): DataColumn<EnrichedSchedule>[] {
  const { t } = useTranslation(["settings", "agents", "common"]);

  const columns: DataColumn<EnrichedSchedule>[] = [
    {
      id: "name",
      header: t("schedules.column.name"),
      width: "minmax(160px,1.4fr)",
      cell: (schedule) => (
        <div className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{schedule.name || schedule.id}</span>
            {schedule.unread_count > 0 && (
              <span className="bg-destructive text-destructive-foreground relative z-10 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
                {schedule.unread_count > 99 ? "99+" : schedule.unread_count}
              </span>
            )}
          </span>
          {/* Which agent it fires: the whole point of a schedule, and the card
              only showed it inside the next-run strip, so a disabled schedule
              did not say it at all. */}
          <span className="text-muted-foreground truncate text-xs">{agentName(schedule)}</span>
        </div>
      ),
    },
    {
      id: "cron",
      header: t("schedules.column.cron"),
      width: "128px",
      tier: 2,
      cell: (schedule) => (
        <span
          className="bg-primary-soft text-primary relative z-10 truncate rounded px-1.5 py-0.5 font-mono text-[0.72rem]"
          title={schedule.timezone ?? undefined}
        >
          {schedule.cron_expression}
        </span>
      ),
    },
    {
      id: "state",
      header: t("schedules.column.state"),
      width: "116px",
      cell: (schedule) => (
        <>
          <ScheduleStatusBadge enabled={schedule.enabled ?? true} />
          {schedule.running_runs > 0 && (
            <Loader2
              className="text-primary size-3.5 shrink-0 animate-spin"
              aria-label={t("status.running", { ns: "common" })}
            />
          )}
        </>
      ),
    },
    {
      id: "next",
      header: t("schedules.column.next"),
      width: "minmax(110px,1fr)",
      tier: 3,
      cell: (schedule) =>
        // A disabled schedule keeps a `next_run_at` in the database; showing it
        // would promise a run that is not coming.
        schedule.enabled && schedule.next_run_at ? (
          <span className="truncate text-xs">{formatDateField(schedule.next_run_at)}</span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      id: "last",
      header: t("schedules.column.last"),
      width: "minmax(110px,1fr)",
      tier: 3,
      cell: (schedule) =>
        schedule.last_run_at ? (
          <span className="text-muted-foreground truncate text-xs">
            {formatDateField(schedule.last_run_at)}
            {schedule.last_run_number > 0 && (
              <span className="ml-1 font-mono">#{schedule.last_run_number}</span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground/50">{t("schedules.neverRan")}</span>
        ),
    },
    {
      id: "actor",
      header: t("schedules.column.actor"),
      width: "132px",
      tier: 3,
      cell: (schedule) => (
        <ActorLabel
          actor_type={schedule.actor_type}
          actor_name={schedule.actor_name}
          className="text-muted-foreground min-w-0 truncate text-xs"
        />
      ),
    },
  ];

  return columns;
}

export function SchedulesTable({
  schedules,
  columns,
  isLoading,
  isError,
  empty,
  columnMode,
}: {
  schedules: EnrichedSchedule[];
  /** From {@link useScheduleColumns}, minus whatever the reader hid. */
  columns: DataColumn<EnrichedSchedule>[];
  isLoading?: boolean;
  isError?: boolean;
  empty?: React.ReactNode;
  /** Level-one collections keep every reader-selected column reachable. */
  columnMode?: "tiered" | "scroll";
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);

  return (
    <DataTable
      label={t("schedules.tableLabel")}
      columns={columns}
      columnMode={columnMode}
      rows={schedules}
      isLoading={isLoading}
      isError={isError}
      empty={empty ?? <EmptyState message={t("schedules.empty")} icon={Calendar} compact />}
      rowKey={(schedule) => schedule.id}
      rowHref={(schedule) => `/schedules/${schedule.id}`}
      rowLabel={(schedule) => schedule.name || schedule.id}
    />
  );
}
