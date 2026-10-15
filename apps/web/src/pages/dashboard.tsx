// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "../hooks/use-auth";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { usePermissions } from "../hooks/use-permissions";
import { ErrorState } from "../components/page-states";
import { DashboardBodySkeleton } from "../components/loading-skeletons";
import { useRunAgentName } from "../hooks/use-run-agent-name";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { DashboardContent, DashboardHeader } from "./dashboard-content";

export function DashboardPage() {
  const { profile, user } = useAuth();
  // Every query below gates itself on its guard; `DashboardContent` draws a
  // section only when the read that feeds it is open to the caller and holds
  // something.
  const { ready } = usePermissions();
  const {
    data: runsData,
    isLoading: runsLoading,
    error: runsError,
  } = usePaginatedRuns({
    limit: 15,
    offset: 0,
  });
  const { data: agents, isLoading: agentsLoading, error: agentsError } = useAgents();
  const agentName = useRunAgentName();
  const { data: unreadCounts } = useUnreadCountsByAgent();
  // The schedules feed one section and one figure; their failure is not the
  // dashboard's, but the body waits for them so neither is drawn as « none »
  // first and then reflowed.
  const { data: schedules, isLoading: schedulesLoading } = useAllSchedules();
  const firstName = (profile?.displayName || user?.name || "").split(/\s+/)[0] ?? "";

  // A disabled query is not loading, so an unresolved permission set must be.
  const isLoading = !ready || runsLoading || agentsLoading || schedulesLoading;
  const error = runsError || agentsError;

  // The greeting is known before any read: only the body waits.
  if (isLoading)
    return (
      <div className="mx-auto w-full max-w-[1300px] space-y-8">
        <DashboardHeader firstName={firstName} />
        <DashboardBodySkeleton />
      </div>
    );
  if (error) return <ErrorState error={error} />;

  const runs = runsData?.data ?? [];

  // Build agent lookup map
  const agentMap = new Map<string, NonNullable<typeof agents>[number]>();
  if (agents) {
    for (const agent of agents) agentMap.set(agent.id, agent);
  }

  // Deduplicate runs by packageId (keep first = most recent), limit to 8
  // Only include agents that still exist (agentMap lookup)
  const recentAgentIds: string[] = [];
  const seen = new Set<string>();
  for (const exec of runs) {
    if (!exec.packageId || seen.has(exec.packageId)) continue;
    seen.add(exec.packageId);
    if (agentMap.has(exec.packageId)) {
      recentAgentIds.push(exec.packageId);
    }
    if (recentAgentIds.length >= 8) break;
  }

  const orderedAgents = recentAgentIds
    .map((id) => agentMap.get(id))
    .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
  for (const agent of agents ?? []) {
    if (!seen.has(agent.id)) orderedAgents.push(agent);
  }

  return (
    <div className="mx-auto w-full max-w-[1300px]">
      <DashboardContent
        {...{
          firstName,
          agents: orderedAgents,
          runs,
          runTotal: runsData?.total ?? runs.length,
          schedules: schedules ?? [],
          agentName,
          unreadCounts,
        }}
      />
    </div>
  );
}
