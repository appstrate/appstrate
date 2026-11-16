// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "../hooks/use-auth";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { usePermissions } from "../hooks/use-permissions";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { ErrorState } from "../components/page-states";
import { DashboardBodySkeleton } from "../components/loading-skeletons";
import { useRunAgentName } from "../hooks/use-run-agent-name";
import { recentAgentsFirst } from "../lib/recent-agents";
import { DashboardContent, DashboardHeader } from "./dashboard-content";

/**
 * `/`: the working space's dashboard, or in « Vue d'ensemble » the mode's home, drawn from every
 * space the reader reaches (the org routes of its three lists), read-only.
 */
export function DashboardPage() {
  const { profile, user } = useAuth();
  // Every query gates itself on its guard; `DashboardContent` draws a section only when its read is open and non-empty.
  const { ready } = usePermissions();
  // The mode is known once the space listing is: the body waits for it.
  const { on: spanning, known } = useOverviewMode();
  const {
    data: runsData,
    isLoading: runsLoading,
    error: runsError,
  } = usePaginatedRuns({ limit: 15, offset: 0, spanning });
  const { data: agents, isLoading: agentsLoading, error: agentsError } = useAgents(spanning);
  // The same query as the agents above: no second request.
  const agentName = useRunAgentName(undefined, spanning);
  // Their failure is not the dashboard's, but the body waits so nothing reflows from « none ».
  const { data: schedules, isLoading: schedulesLoading } = useAllSchedules(spanning);
  const firstName = (profile?.displayName || user?.name || "").split(/\s+/)[0] ?? "";

  // A disabled query is not loading, so an unresolved permission set (or listing) must be.
  const isLoading = !ready || !known || runsLoading || agentsLoading || schedulesLoading;
  const error = runsError || agentsError;

  // The greeting is known before any read: only the body waits.
  if (isLoading)
    return (
      <div>
        <DashboardHeader firstName={firstName} />
        <DashboardBodySkeleton />
      </div>
    );
  if (error) return <ErrorState error={error} />;

  const runs = runsData?.data ?? [];

  return (
    <DashboardContent
      {...{
        firstName,
        spanning,
        agents: recentAgentsFirst(runs, agents ?? []),
        runs,
        runTotal: runsData?.total ?? runs.length,
        schedules: schedules ?? [],
        agentName,
      }}
    />
  );
}
