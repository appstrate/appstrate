// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "./status-badge";
import { RunTrigger } from "./run-trigger";
import { cn } from "@/lib/utils";
import { formatDateField } from "../lib/markdown";
import { ACTIVE_RUN_STATUSES, type EnrichedRun } from "@appstrate/shared-types";

/** Shared column grid between the data-table header and its rows. */
export const RUN_GRID =
  "grid grid-cols-[58px_minmax(0,1fr)_104px_82px] items-center gap-3 sm:grid-cols-[64px_minmax(0,1fr)_112px_124px_84px_96px]";

const TINTS = [
  "bg-primary-soft text-primary",
  "bg-spark-soft text-spark",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
];

function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

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
  const isRunning = (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(run.status);
  const isUnread = run.notifiedAt != null && run.readAt == null;
  const date = run.started_at ? formatDateField(run.started_at) : "";
  const isInline = run.package_ephemeral === true;
  const isRemote = run.runOrigin === "remote";
  const isOrphaned = run.packageId == null && !isInline;
  const tint = tintFor(run.packageId ?? run.agent_name ?? run.id);

  // Live elapsed timer while running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !run.started_at) return;
    const start = new Date(run.started_at).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isRunning, run.started_at]);

  const time = isRunning ? elapsed : run.duration;
  const duration = time ? `${(time / 1000).toFixed(1)}s` : "—";

  const flagBadge = (label: string, title?: string) => (
    <span
      className="border-border text-muted-foreground hidden shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase sm:inline-block"
      title={title}
    >
      {label}
    </span>
  );

  const content = (
    <>
      {/* N° */}
      <div className="flex items-center gap-1.5">
        <span
          className="bg-spark size-1.5 shrink-0 rounded-full"
          style={{ visibility: isUnread ? "visible" : "hidden" }}
        />
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {run.runNumber != null ? `#${run.runNumber}` : "—"}
        </span>
      </div>

      {/* Agent */}
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md",
            tint,
          )}
        >
          <Activity className="size-3.5" />
        </span>
        <span className="truncate font-medium">{agentName ?? run.agent_name ?? run.packageId}</span>
        {isInline && flagBadge(t("runs.inlineBadge"))}
        {isOrphaned && flagBadge(t("runs.deletedAgentBadge"), t("runs.deletedAgentTitle"))}
        {isRemote && flagBadge(t("runs.remoteBadge"), t("runs.remoteBadgeTitle"))}
      </div>

      {/* Statut */}
      <div className="flex">
        <Badge status={run.status} compact unread={isUnread} />
      </div>

      {/* Déclencheur */}
      <div className="hidden min-w-0 sm:flex">
        <RunTrigger run={run} />
      </div>

      {/* Durée */}
      <div className="text-muted-foreground hidden font-mono text-xs tabular-nums sm:block">
        {duration}
      </div>

      {/* Heure */}
      <div className="text-muted-foreground truncate text-right text-xs sm:text-left">{date}</div>
    </>
  );

  const className = cn(
    RUN_GRID,
    "border-border/70 min-h-[52px] border-b px-4 py-2 text-sm last:border-b-0",
    !disableLink && "hover:bg-accent/50 cursor-pointer transition-colors",
  );

  if (disableLink || isOrphaned) {
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
