// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { Calendar } from "lucide-react";
import { Badge } from "./status-badge";
import { ScheduleStatusBadge } from "./schedule-status-badge";
import { NextRunPreview } from "./next-run-preview";
import { ActorLabel } from "./actor-label";
import { useScheduleRuns } from "../hooks/use-schedules";
import { ACTIVE_RUN_STATUSES, type EnrichedSchedule } from "@appstrate/shared-types";

interface ScheduleCardProps {
  schedule: EnrichedSchedule;
  agentName?: string;
}

export function ScheduleCard({ schedule, agentName }: ScheduleCardProps) {
  const { data: runs } = useScheduleRuns(schedule.id);

  // Running + unread counts scoped to this schedule's runs
  const runningRuns = runs?.filter((e) => ACTIVE_RUN_STATUSES.has(e.status)).length ?? 0;
  const unreadCount = runs?.filter((e) => e.notifiedAt != null && e.readAt == null).length ?? 0;

  const isActive = schedule.enabled ?? true;
  const lastRunNumber = runs?.[0]?.runNumber ?? 0;

  return (
    <Link
      to={`/schedules/${schedule.id}`}
      className="border-border bg-card hover:border-foreground/20 block overflow-hidden rounded-[var(--radius)] border shadow-sm transition-colors"
    >
      <div className="flex items-center gap-3 p-3">
        <span className="bg-primary-soft text-primary flex size-9 shrink-0 items-center justify-center rounded-[9px]">
          <Calendar className="size-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{schedule.name || schedule.id}</span>
            <ScheduleStatusBadge enabled={schedule.enabled ?? true} />
            {unreadCount > 0 && (
              <span className="bg-spark text-spark-foreground flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[0.62rem] leading-none font-semibold">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
            {runningRuns > 0 && <Badge status="running" />}
          </div>
          <ActorLabel
            actor_type={schedule.actor_type}
            actor_name={schedule.actor_name}
            className="text-muted-foreground mt-0.5 text-xs"
          />
        </div>
        {schedule.cron_expression && (
          <span className="bg-primary-soft text-primary shrink-0 rounded-md px-2 py-0.5 font-mono text-[0.74rem]">
            {schedule.cron_expression}
          </span>
        )}
      </div>

      {/* Next run preview -- flush to card edges */}
      {isActive && schedule.next_run_at && (
        <NextRunPreview
          runNumber={lastRunNumber + 1}
          agentName={agentName}
          schedule_name={schedule.name || schedule.id}
          next_run_at={schedule.next_run_at}
          className="border-border border-t border-dashed"
        />
      )}
    </Link>
  );
}
