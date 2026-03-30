import { Link } from "react-router-dom";
import { User, Building2, Layers } from "lucide-react";
import { Badge } from "./status-badge";
import { ScheduleStatusBadge } from "./schedule-status-badge";
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

  const statusBadge = (
    <ScheduleStatusBadge
      enabled={schedule.enabled ?? true}
      hasProviders={effectiveHasProviders}
      allReady={effectiveReady}
    />
  );

  const ProfileIcon = schedule.profileType === "org" ? Building2 : User;

  return (
    <Link
      to={`/schedules/${schedule.id}`}
      className="block rounded-lg border border-border bg-card p-3 hover:bg-accent/50 transition-colors"
    >
      {/* Line 1: name + status badge + running/unread indicators */}
      <div className="flex items-center gap-2">
        <span className="font-medium truncate">{schedule.name || schedule.id}</span>
        {statusBadge}
        {unreadCount > 0 && (
          <span className="flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[0.6rem] font-medium leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
        {runningExecutions > 0 && <Badge status="running" />}
      </div>

      {/* Line 2: profile + flow name */}
      <div className="flex items-center gap-2 mt-1.5">
        {schedule.profileName && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ProfileIcon className="size-3" />
            {schedule.profileType === "user" && schedule.profileOwnerName
              ? `${schedule.profileOwnerName} — ${schedule.profileName}`
              : schedule.profileName}
          </span>
        )}
        {schedule.profileName && flowName && (
          <span className="text-xs text-muted-foreground/50">·</span>
        )}
        {flowName && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Layers className="size-3" />
            {flowName}
          </span>
        )}
      </div>
    </Link>
  );
}
