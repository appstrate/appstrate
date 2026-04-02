// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { Badge } from "./status-badge";
import { ScheduleStatusBadge } from "./schedule-status-badge";
import { NextRunPreview } from "./next-run-preview";
import { ProfileLabel } from "./profile-label";
import { useScheduleExecutions } from "../hooks/use-schedules";
import { useScheduleProviderReadiness } from "../hooks/use-schedule-readiness";
import type { EnrichedSchedule } from "@appstrate/shared-types";

interface ScheduleCardProps {
  schedule: EnrichedSchedule;
  agentName?: string;
}

export function ScheduleCard({ schedule, agentName }: ScheduleCardProps) {
  const { data: runs } = useScheduleExecutions(schedule.id);
  const { totalProviders, allReady, isLoading } = useScheduleProviderReadiness(schedule);
  const hasProviders = totalProviders > 0;

  // Running + unread counts scoped to this schedule's runs
  const runningRuns =
    runs?.filter((e) => e.status === "running" || e.status === "pending").length ?? 0;
  const unreadCount = runs?.filter((e) => e.notifiedAt != null && e.readAt == null).length ?? 0;

  // While client-side readiness is loading, use the server-side readiness from EnrichedSchedule
  const effectiveReady = isLoading ? schedule.readiness.status === "ready" : allReady;
  const effectiveHasProviders = isLoading ? schedule.readiness.totalProviders > 0 : hasProviders;

  const isActive = (schedule.enabled ?? true) && effectiveReady;
  const lastRunNumber = runs?.[0]?.runNumber ?? 0;

  const statusBadge = (
    <ScheduleStatusBadge
      enabled={schedule.enabled ?? true}
      hasProviders={effectiveHasProviders}
      allReady={effectiveReady}
    />
  );

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
        <ProfileLabel
          profileType={schedule.profileType}
          profileName={schedule.profileName}
          profileOwnerName={schedule.profileOwnerName}
          className="text-muted-foreground ml-auto text-xs"
        />
      </div>

      {/* Next run preview -- flush to card edges */}
      {isActive && schedule.nextRunAt && (
        <NextRunPreview
          runNumber={lastRunNumber + 1}
          agentName={agentName}
          scheduleName={schedule.name || schedule.id}
          nextRunAt={schedule.nextRunAt}
          className="border-border border-t border-dashed"
        />
      )}
    </Link>
  );
}
