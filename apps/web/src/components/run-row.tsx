// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Shield, User, Calendar } from "lucide-react";
import { Badge } from "./status-badge";
import { cn } from "@/lib/utils";
import { formatDateField } from "../lib/markdown";
import type { Run } from "@appstrate/shared-types";

export function RunRow({
  run,
  agentName,
  userName,
  scheduleName,
}: {
  run: Run;
  agentName?: string;
  userName?: string;
  scheduleName?: string | null;
}) {
  const isRunning = run.status === "running" || run.status === "pending";
  const isUnread = run.notifiedAt != null && run.readAt == null;
  const date = run.startedAt ? formatDateField(run.startedAt) : "";

  // Live elapsed timer while running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !run.startedAt) return;
    const start = new Date(run.startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isRunning, run.startedAt]);

  const time = isRunning ? elapsed : run.duration;
  const duration = time ? `${(time / 1000).toFixed(1)}s` : "";

  return (
    <Link
      className={cn(
        "hover:bg-muted/50 flex items-center gap-2 px-3 py-3 text-sm transition-colors sm:py-2",
      )}
      to={`/agents/${run.packageId}/runs/${run.id}`}
      state={{ runNumber: run.runNumber }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {run.runNumber != null && (
          <span className="text-muted-foreground shrink-0 font-mono text-xs">#{run.runNumber}</span>
        )}
        {agentName && <span className="truncate font-medium">{agentName}</span>}
        <Badge status={run.status} compact unread={isUnread} />

        {/* Trigger: icon only on mobile, icon + text on desktop */}
        {run.scheduleId ? (
          <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
            <Calendar size={12} className="shrink-0" />
            <span className="truncate">{scheduleName || run.scheduleId}</span>
          </span>
        ) : userName ? (
          <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
            <User size={12} className="shrink-0" />
            <span className="truncate">{userName}</span>
          </span>
        ) : null}

        {run.proxyLabel && (
          <Shield size={12} className="text-muted-foreground hidden shrink-0 sm:block" />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {duration && (
            <span className="text-muted-foreground hidden font-mono text-xs sm:inline">
              {duration}
            </span>
          )}
          <span className="text-muted-foreground text-xs">{date}</span>
        </div>
      </div>
    </Link>
  );
}
