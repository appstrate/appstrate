// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AgentListItem, EnrichedRun } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { RunStatusBadge } from "./status-badge";
import { RunIdentity } from "./run-identity";
import { runDetailPath } from "../lib/package-paths";
import { useSpaceLink } from "../hooks/use-current-space";
import { SpaceNameOf } from "./space-name";

/**
 * A run as a dense list row, wherever runs are listed outside a table (the
 * dashboard, the chat's context panel): its identity (`RunIdentity`, the runs
 * table's « Run » column), then the run's space in a list spanning spaces (the runs table's
 * « Espace » cell), then its status.
 * The row is the run's link when the run still has an agent to live under.
 */
export function RunRow({
  run,
  agentName,
  agent,
  dense = false,
  spanning = false,
  className,
}: {
  run: EnrichedRun;
  agentName: string;
  /** The run's agent, for its identity tile. */
  agent?: Pick<AgentListItem, "icon" | "color">;
  /** A narrow panel: a compact status. */
  dense?: boolean;
  /** « Tous les espaces »: the row names its run's space. */
  spanning?: boolean;
  className?: string;
}) {
  const content = (
    <>
      <RunIdentity run={run} agent={{ name: agentName, identity: agent }} />
      {spanning && <RowSpaceName spaceId={run.spaceId} />}
      <RunStatusBadge status={run.status} unread={run.unread} compact={dense} />
    </>
  );

  // Its own container: a compact status follows the row's width, not the screen's.
  return (
    <RunLink
      run={run}
      className={cn("@container flex min-h-16 items-center gap-3 px-4 py-3", className)}
    >
      {content}
    </RunLink>
  );
}

/**
 * A run's row, whatever it draws of the run: the run's link, hovering like a list row, when the run
 * still has an agent to live under, else a plain row. {@link RunRow}, and the chat summary's
 * one-line runs.
 */
export function RunLink({
  run,
  className,
  children,
}: {
  run: Pick<EnrichedRun, "id" | "packageId" | "runNumber" | "spaceId">;
  className: string;
  children: ReactNode;
}) {
  const linkInSpace = useSpaceLink();
  return run.packageId ? (
    <Link
      to={linkInSpace(runDetailPath(run.packageId, run.id), run.spaceId)}
      state={{ runNumber: run.runNumber }}
      className={cn(className, "hover:bg-muted/50 transition-colors")}
    >
      {children}
    </Link>
  ) : (
    <div className={className}>{children}</div>
  );
}

/**
 * The space of a row in a list spanning spaces, between its identity and its status: the runs
 * table's « Espace » cell, given at most a third of the row so the identity keeps the rest.
 */
export function RowSpaceName({ spaceId }: { spaceId: string | undefined }) {
  return <SpaceNameOf spaceId={spaceId} className="text-muted-foreground max-w-[33%] shrink" />;
}
