// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Activity, Plus, Layers, CalendarClock, Zap, ArrowRight } from "lucide-react";
import { useAuth } from "../hooks/use-auth";
import { useAgents } from "../hooks/use-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { useAllSchedules } from "../hooks/use-schedules";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { LoadingState, ErrorState } from "../components/page-states";
import { PackageCard } from "../components/package-card";
import { ScheduleCard } from "../components/schedule-card";
import { RunList } from "../components/run-list";
import { StatTile } from "../components/stat-tile";
import { Button } from "@/components/ui/button";

function SectionHead({
  title,
  to,
  action,
}: {
  title: string;
  to?: string;
  action?: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[0.92rem] font-semibold tracking-tight">{title}</h2>
      {to && action && (
        <Link
          to={to}
          className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 text-[0.82rem] font-medium transition-colors hover:underline"
        >
          {action} <ArrowRight className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

export function DashboardPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { profile, user } = useAuth();
  const {
    data: runsData,
    isLoading: runsLoading,
    error: runsError,
  } = usePaginatedRuns({ limit: 15, offset: 0 });
  const { data: agents, isLoading: agentsLoading, error: agentsError } = useAgents();
  const { data: unreadCounts } = useUnreadCountsByAgent();
  const { data: schedules } = useAllSchedules();

  const isLoading = runsLoading || agentsLoading;
  const error = runsError || agentsError;

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const runs = runsData?.data ?? [];
  const agentsCount = agents?.length ?? 0;
  const runningCount = agents?.reduce((n, a) => n + (a.running_runs ?? 0), 0) ?? 0;
  const runsTotal = runsData?.total ?? runs.length;

  const agentMap = new Map<
    string,
    {
      displayName: string;
      description?: string | null;
      source?: string;
      keywords?: string[];
      running_runs?: number;
    }
  >();
  if (agents) {
    for (const f of agents) {
      agentMap.set(f.id, {
        displayName: f.display_name,
        description: f.description,
        source: f.source,
        keywords: f.keywords,
        running_runs: f.running_runs,
      });
    }
  }

  // Recent agents (dedupe by run, keep agents that still exist), limit 8
  const recentAgentIds: string[] = [];
  const seen = new Set<string>();
  for (const exec of runs) {
    if (!exec.packageId || seen.has(exec.packageId)) continue;
    seen.add(exec.packageId);
    if (agentMap.has(exec.packageId)) recentAgentIds.push(exec.packageId);
    if (recentAgentIds.length >= 8) break;
  }

  const upcomingSchedules = (schedules ?? [])
    .filter((s) => s.enabled !== false && s.next_run_at)
    .sort((a, b) => new Date(a.next_run_at!).getTime() - new Date(b.next_run_at!).getTime())
    .slice(0, 5);

  const firstName = (profile?.displayName || user?.name || "").split(/\s+/)[0];

  return (
    <div className="mx-auto w-full max-w-[1300px] p-8 pb-16">
      {/* Welcome + actions */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <h1 className="flex items-center gap-2 text-[1.85rem] font-bold tracking-tight">
          {t("dashboard.welcome", { name: firstName, ns: "common" })}
          <Zap className="text-spark size-6" />
        </h1>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/runs">
              <Activity className="size-4" /> {t("dashboard.seeRuns", { defaultValue: "Voir les exécutions" })}
            </Link>
          </Button>
          <Button asChild>
            <Link to="/agents/new">
              <Plus className="size-4" /> {t("list.create")}
            </Link>
          </Button>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label={t("nav.agents", { ns: "common" })}
          value={agentsCount}
          icon={Layers}
          tint="primary"
          sub={t("list.running", { count: runningCount })}
        />
        <StatTile
          label={t("nav.runs", { ns: "common" })}
          value={runsTotal}
          icon={Activity}
          tint="success"
        />
        <StatTile
          label={t("nav.schedules", { ns: "common" })}
          value={schedules?.length ?? 0}
          icon={CalendarClock}
          tint="warning"
          sub={
            upcomingSchedules.length > 0
              ? `${upcomingSchedules.length} ${t("dashboard.upcomingShort", { defaultValue: "à venir" })}`
              : undefined
          }
        />
        <StatTile
          label={t("dashboard.running", { defaultValue: "En cours" })}
          value={runningCount}
          icon={Zap}
          tint="spark"
        />
      </div>

      {/* Recent agents */}
      {recentAgentIds.length > 0 && (
        <section className="mb-8">
          <SectionHead title={t("dashboard.recentAgents")} to="/agents" action={t("dashboard.seeAll")} />
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
                    runningRuns={agent?.running_runs}
                    keywords={agent?.keywords}
                    unreadCount={unreadCounts?.[agentId]}
                  />
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Recent runs + upcoming schedules */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.45fr_1fr]">
        <section>
          <SectionHead title={t("dashboard.recentRuns")} to="/runs" action={t("dashboard.seeAll")} />
          <RunList pageSize={7} paginated={false} showHeader={false} />
        </section>
        <section>
          <SectionHead
            title={t("dashboard.upcomingSchedules")}
            to="/schedules"
            action={t("dashboard.seeAll")}
          />
          {upcomingSchedules.length > 0 ? (
            <div className="space-y-2">
              {upcomingSchedules.map((sched) => (
                <ScheduleCard
                  key={sched.id}
                  schedule={sched}
                  agentName={agentMap.get(sched.packageId)?.displayName}
                />
              ))}
            </div>
          ) : (
            <div className="border-border bg-card text-muted-foreground rounded-[var(--radius)] border p-6 text-center text-sm shadow-sm">
              {t("detail.emptySchedule")}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
