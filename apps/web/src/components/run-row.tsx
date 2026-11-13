// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import type { AgentListItem, EnrichedRun } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { RunStatusBadge } from "./status-badge";
import { RunIdentity } from "./run-identity";
import { runDetailPath } from "../lib/package-paths";

/**
 * A run as a dense list row, wherever runs are listed outside a table (the
 * dashboard, the chat's context panel): its identity (`RunIdentity`, the runs
 * table's « Run » column), then its status.
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
  /** A narrow panel: a compact status. */
  dense?: boolean;
  className?: string;
}) {
  const content = (
    <>
      <RunIdentity run={run} agent={{ name: agentName, identity: agent }} />
      <RunStatusBadge status={run.status} unread={run.unread} compact={dense} />
    </>
  );

  // Its own container: a compact status follows the row's width, not the screen's.
  const rowClass = cn("@container flex min-h-16 items-center gap-3 px-4 py-3", className);

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
