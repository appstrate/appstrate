// SPDX-License-Identifier: Apache-2.0

import { Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";
import { useAgents } from "../hooks/use-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { useAllSchedules } from "../hooks/use-schedules";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { LoadingState, ErrorState } from "../components/page-states";
import { PackageCard } from "../components/package-card";
import { ScheduleCard } from "../components/schedule-card";
import { RunList } from "../components/run-list";

export function DashboardPage() {
  const { t } = useTranslation(["agents", "common"]);
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
  const { data: unreadCounts } = useUnreadCountsByAgent();
  const { data: schedules } = useAllSchedules();

  const isLoading = runsLoading || agentsLoading;
  const error = runsError || agentsError;

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const runs = runsData?.data ?? [];

  // No runs → redirect to agents page
  if (runs.length === 0) {
    return <Navigate to="/agents" replace />;
  }

  // Build agent lookup map
  const agentMap = new Map<
    string,
    {
      displayName: string;
      description?: string | null;
      source?: string;
      keywords?: string[];
      providerIds?: string[];
      runningRuns?: number;
    }
  >();
  if (agents) {
    for (const f of agents) {
      agentMap.set(f.id, {
        displayName: f.displayName,
        description: f.description,
        source: f.source,
        keywords: f.keywords,
        providerIds: Object.keys(f.dependencies.providers ?? {}),
        runningRuns: f.runningRuns,
      });
    }
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

  // Upcoming schedules: active, with nextRunAt, sorted by soonest first
  const upcomingSchedules = (schedules ?? [])
    .filter((s) => s.enabled !== false && s.nextRunAt)
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime())
    .slice(0, 5);

  const firstName = (profile?.displayName || user?.name || "").split(/\s+/)[0];

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-3xl font-bold">
        {t("dashboard.welcome", { name: firstName, ns: "common" })}
      </h1>
      {/* Upcoming schedules */}
      {upcomingSchedules.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t("dashboard.upcomingSchedules")}
            </h2>
            <Link
              to="/schedules"
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            >
              {t("dashboard.seeAll")}
            </Link>
          </div>
          <div className="space-y-2">
            {upcomingSchedules.map((sched) => (
              <ScheduleCard
                key={sched.id}
                schedule={sched}
                agentName={agentMap.get(sched.packageId)?.displayName}
              />
            ))}
          </div>
        </section>
      )}

      {/* Recent agents (horizontal scroll) */}
      {recentAgentIds.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t("dashboard.recentAgents")}
            </h2>
            <Link
              to="/agents"
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            >
              {t("dashboard.seeAll")}
            </Link>
          </div>
          <div className="flex items-stretch gap-3 overflow-x-auto pb-2">
            {recentAgentIds.map((agentId) => {
              const agent = agentMap.get(agentId);
              return (
                <div key={agentId} className="flex max-w-[300px] min-w-[260px] shrink-0">
                  <PackageCard
                    id={agentId}
                    displayName={agent?.displayName ?? agentId}
                    description={agent?.description}
                    type="agent"
                    source={agent?.source as "system" | "local" | undefined}
                    runningRuns={agent?.runningRuns}
                    keywords={agent?.keywords}
                    providerIds={agent?.providerIds}
                    unreadCount={unreadCounts?.[agentId]}
                  />
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Recent runs */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-muted-foreground text-sm font-medium">{t("dashboard.recentRuns")}</h2>
          <Link
            to="/runs"
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            {t("dashboard.seeAll")}
          </Link>
        </div>
        <RunList pageSize={7} paginated={false} />
      </section>
    </div>
  );
}
