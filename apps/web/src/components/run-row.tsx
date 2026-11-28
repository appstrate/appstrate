// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import type { AgentListItem, EnrichedRun } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { RunStatusBadge } from "./status-badge";
import { RunIdentity } from "./run-identity";
import { useRunPageHref } from "../hooks/use-run-page-href";
import { SpaceNameOf } from "./space-name";

/**
 * A run as a dense list row on the dashboard, where runs are listed outside a table: its identity
 * (`RunIdentity`, the runs table's « Run » column), then the run's space in a list spanning spaces
 * (the runs table's « Espace » cell), then its status.
 * The row is the run's link when the run still has an agent to live under and its page opens
 * for the reader.
 */
export function RunRow({
  run,
  agentName,
  agent,
  spanning = false,
}: {
  run: EnrichedRun;
  agentName: string;
  /** The run's agent, for its identity tile. */
  agent?: Pick<AgentListItem, "icon" | "color">;
  /** « Tous les espaces »: the row names its run's space. */
  spanning?: boolean;
}) {
  const href = useRunPageHref(run);
  const className = "flex min-h-16 items-center gap-3 px-4 py-3";
  const content = (
    <>
      <RunIdentity run={run} agent={{ name: agentName, identity: agent }} />
      {spanning && <RowSpaceName spaceId={run.spaceId} />}
      <RunStatusBadge status={run.status} unread={run.unread} />
    </>
  );
  return href ? (
    <Link
      to={href}
      state={{ runNumber: run.runNumber }}
      className={cn(className, "hover:bg-muted/50 transition-colors")}
    >
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

/**
 * The space of a row in a list spanning spaces, between its identity and its status: the runs
 * table's « Espace » cell, given at most a third of the row so the identity keeps the rest.
 */
export function RowSpaceName({ spaceId }: { spaceId: string | undefined }) {
  return <SpaceNameOf spaceId={spaceId} className="text-muted-foreground max-w-[33%] shrink" />;
}
