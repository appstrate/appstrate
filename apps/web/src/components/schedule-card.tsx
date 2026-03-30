import { Link } from "react-router-dom";
import { Badge } from "./status-badge";
import { ScheduleStatusBadge } from "./schedule-status-badge";
import { NextExecutionPreview } from "./next-execution-preview";
import { ProfileLabel } from "./profile-label";
import { useScheduleExecutions } from "../hooks/use-schedules";
import { useScheduleProviderReadiness } from "../hooks/use-schedule-readiness";
import type { EnrichedSchedule } from "@appstrate/shared-types";

interface ScheduleCardProps {
  schedule: EnrichedSchedule;
  flowName?: string;
}

export function ScheduleCard({ schedule, flowName }: ScheduleCardProps) {
  const { data: executions } = useScheduleExecutions(schedule.id);
  const { totalProviders, allReady, isLoading } = useScheduleProviderReadiness(schedule);
  const hasProviders = totalProviders > 0;

  // Running + unread counts scoped to this schedule's executions
  const runningExecutions =
    executions?.filter((e) => e.status === "running" || e.status === "pending").length ?? 0;
  const unreadCount =
    executions?.filter((e) => e.notifiedAt != null && e.readAt == null).length ?? 0;

  // While client-side readiness is loading, use the server-side readiness from EnrichedSchedule
  const effectiveReady = isLoading ? schedule.readiness.status === "ready" : allReady;
  const effectiveHasProviders = isLoading ? schedule.readiness.totalProviders > 0 : hasProviders;

  const isActive = (schedule.enabled ?? true) && effectiveReady;
  const lastExecutionNumber = executions?.[0]?.executionNumber ?? 0;

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
      className="block rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
    >
      <div className="flex items-center gap-2 p-3">
        <span className="font-medium truncate">{schedule.name || schedule.id}</span>
        {statusBadge}
        {unreadCount > 0 && (
          <span className="flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[0.6rem] font-medium leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
        {runningExecutions > 0 && <Badge status="running" />}
        <ProfileLabel
          profileType={schedule.profileType}
          profileName={schedule.profileName}
          profileOwnerName={schedule.profileOwnerName}
          className="ml-auto text-xs text-muted-foreground"
        />
      </div>

      {/* Next run preview — flush to card edges */}
      {isActive && schedule.nextRunAt && (
        <NextExecutionPreview
          executionNumber={lastExecutionNumber + 1}
          flowName={flowName}
          scheduleName={schedule.name || schedule.id}
          nextRunAt={schedule.nextRunAt}
          className="border-t border-dashed border-border"
        />
      )}
    </Link>
  );
}
