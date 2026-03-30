import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Shield, User, Calendar } from "lucide-react";
import { Badge } from "./status-badge";
import { cn } from "@/lib/utils";
import { formatDateField } from "../lib/markdown";
import { useAllSchedules } from "../hooks/use-schedules";
import type { Execution } from "@appstrate/shared-types";

export function ExecutionRow({
  execution,
  flowName,
  userName,
}: {
  execution: Execution;
  flowName?: string;
  userName?: string;
}) {
  const isRunning = execution.status === "running" || execution.status === "pending";
  const isUnread = execution.notifiedAt != null && execution.readAt == null;
  const date = execution.startedAt ? formatDateField(execution.startedAt) : "";

  // Resolve schedule name if triggered by a schedule
  const { data: schedules } = useAllSchedules();
  const scheduleName = execution.scheduleId
    ? (schedules?.find((s) => s.id === execution.scheduleId)?.name ?? null)
    : null;

  // Live elapsed timer while running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !execution.startedAt) return;
    const start = new Date(execution.startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isRunning, execution.startedAt]);

  const time = isRunning ? elapsed : execution.duration;
  const duration = time ? `${(time / 1000).toFixed(1)}s` : "";

  return (
    <Link
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50 transition-colors",
      )}
      to={`/flows/${execution.packageId}/executions/${execution.id}`}
      state={{ executionNumber: execution.executionNumber }}
    >
      <div className="flex flex-1 items-center gap-2 min-w-0">
        {execution.executionNumber != null && (
          <span className="text-muted-foreground font-mono text-xs">
            #{execution.executionNumber}
          </span>
        )}
        {flowName && <span className="font-medium truncate max-w-[150px]">{flowName}</span>}
        <Badge status={execution.status} />
        {isUnread && <span className="size-2 rounded-full bg-destructive shrink-0" />}

        {/* Trigger: schedule or user */}
        {execution.scheduleId ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
            <Calendar size={12} />
            {scheduleName || execution.scheduleId}
          </span>
        ) : userName ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
            <User size={12} />
            {userName}
          </span>
        ) : null}

        {execution.proxyLabel && <Shield size={12} className="text-muted-foreground" />}
        <div className="ml-auto flex items-center gap-2">
          {duration && <span className="text-muted-foreground text-xs font-mono">{duration}</span>}
          <span className="text-muted-foreground text-xs">{date}</span>
        </div>
      </div>
    </Link>
  );
}
