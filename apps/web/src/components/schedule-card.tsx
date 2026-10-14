// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "./status-badge";
import { ScheduleStatusBadge } from "./schedule-status-badge";
import { ActorLabel } from "./actor-label";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import { formatDateField } from "../lib/format-date";

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
  const unreadCount = schedule.unread_count;

  return (
    <Link
      to={`/schedules/${schedule.id}`}
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
          {unreadCount > 0 && (
            <span className="bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          {runningRuns > 0 && <Badge status="running" />}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{t("schedules.column.cron")}</dt>
          <dd className="mt-1 truncate font-mono" title={schedule.timezone ?? undefined}>
            {schedule.cron_expression}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{t("schedules.column.next")}</dt>
          <dd className="mt-1 truncate">
            {schedule.enabled && schedule.next_run_at ? formatDateField(schedule.next_run_at) : "—"}
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
