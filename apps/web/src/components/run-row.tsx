// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "./status-badge";
import { RunTrigger } from "./run-trigger";
import { cn } from "@/lib/utils";
import { formatDateField } from "../lib/markdown";
import { ACTIVE_RUN_STATUSES, type EnrichedRun } from "@appstrate/shared-types";

export function RunRow({
  run,
  agentName,
  disableLink,
}: {
  run: EnrichedRun;
  agentName?: string;
  /** Render as a static div instead of a Link (e.g. on run detail page). */
  disableLink?: boolean;
}) {
  const { t } = useTranslation(["agents"]);
  const isRunning = ACTIVE_RUN_STATUSES.has(run.status);
  const isUnread = run.notifiedAt != null && run.readAt == null;
  const date = run.startedAt ? formatDateField(run.startedAt) : "";
  const isInline = run.packageEphemeral === true;
  const isRemote = run.runOrigin === "remote";

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

  const content = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {run.runNumber != null && (
        <span className="text-muted-foreground shrink-0 font-mono text-xs">#{run.runNumber}</span>
      )}
      {agentName && <span className="truncate font-medium">{agentName}</span>}
      <Badge status={run.status} compact unread={isUnread} />
      {isInline && (
        <span className="border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
          {t("runs.inlineBadge")}
        </span>
      )}
      {isRemote && (
        <span
          className="border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
          title={t("runs.remoteBadgeTitle")}
        >
          {t("runs.remoteBadge")}
        </span>
      )}

      <RunTrigger run={run} />

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
  );

  const className = cn(
    "flex items-center gap-2 px-3 py-3 text-sm transition-colors sm:py-2",
    !disableLink && "hover:bg-muted/50",
  );

  if (disableLink) {
    return <div className={className}>{content}</div>;
  }

  return (
    <Link
      className={className}
      to={`/agents/${run.packageId}/runs/${run.id}`}
      state={{ runNumber: run.runNumber }}
    >
      {content}
    </Link>
  );
}
