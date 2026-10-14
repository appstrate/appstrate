// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AgentListItem, EnrichedRun } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { AgentIdentityTile } from "./agent-identity";
import { Badge } from "./status-badge";
import { RunProvenanceBadges } from "./run-cells";
import { RunDuration } from "./run-duration";
import { formatDateField } from "../lib/format-date";
import { runDetailPath } from "../lib/package-paths";

/**
 * A run as a dense list row, wherever runs are listed outside a table (the
 * dashboard, the chat's context panel): its agent's tile, the resolved agent
 * name (`useRunAgentName`), its number and provenance, its status and duration.
 * The row is the run's link when the run still has an agent to live under.
 */
export function RunRow({
  run,
  agentName,
  agent,
  dense = false,
  className,
}: {
  run: EnrichedRun;
  agentName: string;
  /** The run's agent, for its identity tile. */
  agent?: Pick<AgentListItem, "icon" | "color">;
  /** A narrow panel: a compact status and no duration column. */
  dense?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("agents");
  const content = (
    <>
      <AgentIdentityTile
        agentId={run.packageId ?? run.agent_name ?? run.id}
        icon={agent?.icon}
        color={agent?.color}
        className="size-8"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{agentName}</span>
          {run.runNumber != null && (
            <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
              #{run.runNumber}
            </span>
          )}
          <RunProvenanceBadges run={run} />
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {run.started_at ? formatDateField(run.started_at) : t("dashboard.runPending")}
        </p>
      </div>
      <Badge status={run.status} unread={run.unread} compact={dense} />
      {!dense && (
        <span className="text-muted-foreground w-14 text-right text-xs tabular-nums">
          <RunDuration status={run.status} startedAt={run.started_at} duration={run.duration} />
        </span>
      )}
    </>
  );

  const rowClass = cn("flex min-h-16 items-center gap-3 px-4 py-3", className);

  return run.packageId ? (
    <Link
      to={runDetailPath(run.packageId, run.id)}
      state={{ runNumber: run.runNumber }}
      className={cn(rowClass, "hover:bg-muted/40 transition-colors")}
    >
      {content}
    </Link>
  ) : (
    <div className={rowClass}>{content}</div>
  );
}
