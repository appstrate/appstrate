// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "../hooks/use-auth";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { ErrorState } from "../components/page-states";
import { useRunAgentName } from "../hooks/use-run-agent-name";
import { DashboardContent } from "./dashboard-content";

export function DashboardPage() {
  const { profile, user } = useAuth();
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
  const { data: schedules, isLoading: schedulesLoading, error: schedulesError } = useAllSchedules();

  const isLoading = runsLoading || agentsLoading || schedulesLoading;
  const error = runsError || agentsError || schedulesError;

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

  // Upcoming schedules: active, with nextRunAt, sorted by soonest first.
  const upcomingSchedules = (schedules ?? [])
    .filter((s) => s.enabled !== false && s.next_run_at)
    .sort((a, b) => new Date(a.next_run_at!).getTime() - new Date(b.next_run_at!).getTime())
    .slice(0, 5);

  const firstName = (profile?.displayName || user?.name || "").split(/\s+/)[0] ?? "";

  return (
    <div className="mx-auto w-full max-w-[1300px]">
      {error && !isLoading ? <ErrorState message={error.message} compact /> : null}
      <DashboardContent
        {...{
          firstName,
          agents: orderedAgents,
          runs,
          runTotal: runsData?.total ?? runs.length,
          schedules: upcomingSchedules,
          agentName,
        }}
      />
    </div>
  );
}
