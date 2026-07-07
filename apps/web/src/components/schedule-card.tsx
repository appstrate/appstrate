// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
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
  // PERF: N+1 — each card issues its own `GET .../schedules/:id/runs`, so a
  // list of N schedules fans out to N requests. Acceptable at current list
  // sizes; if this list grows, hoist the running/unread/last-run counts into
  // the parent's schedule list payload (server-side aggregate) or a single
  // batch endpoint and pass them down as props instead of querying per row.
  const { data: runs } = useScheduleRuns(schedule.id);

  // Running + unread counts scoped to this schedule's runs
  const runningRuns = runs?.filter((e) => ACTIVE_RUN_STATUSES.has(e.status)).length ?? 0;
  const unreadCount = runs?.filter((e) => e.unread).length ?? 0;

  const isActive = schedule.enabled ?? true;
  const lastRunNumber = runs?.[0]?.runNumber ?? 0;

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
