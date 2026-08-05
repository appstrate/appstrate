// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { Badge } from "./status-badge";
import { ScheduleStatusBadge } from "./schedule-status-badge";
import { NextRunPreview } from "./next-run-preview";
import { ActorLabel } from "./actor-label";
import type { EnrichedSchedule } from "@appstrate/shared-types";

interface ScheduleCardProps {
  schedule: EnrichedSchedule;
  agentName?: string;
}

export function ScheduleCard({ schedule, agentName }: ScheduleCardProps) {
  // The three counters this card shows are served WITH the schedule list
  // (`enrichSchedules` in services/scheduler.ts). They used to come from a
  // per-card `GET .../schedules/:id/runs`, which made a list of N schedules
  // fan out to N HTTP requests and ~2N SQL queries just to count three things.
  // They are also whole-history counts now, not counts within the last page of
  // runs the card happened to fetch.
  const runningRuns = schedule.running_runs;
  const unreadCount = schedule.unread_count;
  const lastRunNumber = schedule.last_run_number;

  const isActive = schedule.enabled ?? true;

  const statusBadge = <ScheduleStatusBadge enabled={schedule.enabled ?? true} />;

  return (
    <Link
      to={`/schedules/${schedule.id}`}
      className="border-border bg-card hover:bg-accent/50 block rounded-lg border transition-colors"
    >
      <div className="flex items-center gap-2 p-3">
        <span className="truncate font-medium">{schedule.name || schedule.id}</span>
        {statusBadge}
        {unreadCount > 0 && (
          <span className="bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
        {runningRuns > 0 && <Badge status="running" />}
        <ActorLabel
          actor_type={schedule.actor_type}
          actor_name={schedule.actor_name}
          className="text-muted-foreground ml-auto text-xs"
        />
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
