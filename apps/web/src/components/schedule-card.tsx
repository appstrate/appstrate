// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Badge } from "./status-badge";
import { ScheduleStatusBadge, ScheduleUnreadBadge } from "./schedule-status-badge";
import { ActorLabel } from "./actor-label";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import { formatDateField } from "../lib/format-date";
import { scheduleDetailPath } from "../lib/package-paths";
import { scheduleNextRunAt } from "../lib/schedule-options";
import { describeSchedule } from "../lib/frequency-summary";

interface ScheduleCardProps {
  schedule: EnrichedSchedule;
  agentName?: string;
}

/** A schedule in the schedules collection: a vertical card of comparable facts. */
export function ScheduleCard({ schedule, agentName }: ScheduleCardProps) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  // The counters are served with the schedule list (`enrichSchedules` in
  // services/scheduler.ts) as whole-history counts: the card fetches nothing.
  const runningRuns = schedule.running_runs;
  const nextRunAt = scheduleNextRunAt(schedule);
  const recurrence = describeSchedule(schedule);

  return (
    <Link
      to={scheduleDetailPath(schedule.id)}
      className="border-border bg-card hover:bg-accent/50 flex min-h-44 flex-col rounded-lg border p-4 transition-colors"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{schedule.name || t("schedule.unnamed")}</h2>
          <p className="text-muted-foreground mt-1 truncate text-xs">
            {agentName ?? schedule.packageId}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <ScheduleStatusBadge schedule={schedule} />
          <ScheduleUnreadBadge count={schedule.unread_count} />
          {runningRuns > 0 && <Badge status="running" />}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{t("schedules.column.cron")}</dt>
          <dd
            className={cn("mt-1 truncate", recurrence.isCron && "font-mono")}
            title={recurrence.text}
          >
            {recurrence.text}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{t("schedules.column.next")}</dt>
          <dd className="mt-1 truncate">
            {nextRunAt ? formatDateField(nextRunAt, "datetime", schedule.timezone) : "—"}
          </dd>
        </div>
      </dl>

      <ActorLabel
        actor_type={schedule.actor_type}
        actor_name={schedule.actor_name}
        className="text-muted-foreground mt-auto pt-4 text-xs"
      />
    </Link>
  );
}
