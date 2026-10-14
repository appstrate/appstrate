// SPDX-License-Identifier: Apache-2.0

/**
 * The schedules column set.
 *
 * Columns, not cards: a flex line with the name, some badges and the actor
 * pushed right, plus a strip underneath previewing the next run, stacks into a
 * list where no two rows agree on where anything is — and the one question a
 * schedule list answers, "when does this fire next", would land differently on
 * every row depending on which badges come before it.
 *
 * What the columns say, in order: what it is, how often, whether it is on, when
 * next, when last, and who it runs as.
 */

import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Loader2 } from "lucide-react";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import type { DataColumn } from "./data-table";
import { ScheduleStatusBadge } from "./schedule-status-badge";
import { CountBadge } from "./count-badge";
import { ActorLabel } from "./actor-label";
import { CellDate, CellText } from "./table-cells";
import { formatDateField } from "../lib/format-date";
import { scheduleNextRunAt } from "../lib/schedule-options";
import { describeSchedule } from "../lib/frequency-summary";

/** The column set, as a value the caller holds — see `useRunColumns` on why. */
export function useScheduleColumns({
  agentName,
  showAgentName = true,
}: {
  /** What to call the agent a schedule fires. */
  agentName: (schedule: EnrichedSchedule) => string;
  /** Embedded agent detail already supplies this context in the page heading. */
  showAgentName?: boolean;
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
            <span className="truncate font-medium">{schedule.name || t("schedule.unnamed")}</span>
            <CountBadge
              count={schedule.unread_count}
              label={t("dashboard.unreadRuns", { ns: "agents", count: schedule.unread_count })}
              className="relative z-10 shrink-0"
            />
          </span>
          {/* Which agent it fires: the whole point of a schedule, and the card
              only showed it inside the next-run strip, so a disabled schedule
              did not say it at all. */}
          {showAgentName && <CellText>{agentName(schedule)}</CellText>}
        </div>
      ),
    },
    {
      id: "cron",
      header: t("schedules.column.cron"),
      width: "minmax(140px,1.2fr)",
      tier: 2,
      cell: (schedule) => {
        const recurrence = describeSchedule(schedule);
        return (
          <span
            className={cn("truncate text-xs", recurrence.isCron && "font-mono")}
            title={recurrence.text}
          >
            {recurrence.text}
          </span>
        );
      },
    },
    {
      id: "state",
      header: t("schedules.column.state"),
      width: "116px",
      cell: (schedule) => (
        <>
          <ScheduleStatusBadge schedule={schedule} />
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
      align: "end",
      tier: 3,
      cell: (schedule) => (
        <CellDate value={scheduleNextRunAt(schedule)} timeZone={schedule.timezone} />
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
            {formatDateField(schedule.last_run_at, "datetime", schedule.timezone)}
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
