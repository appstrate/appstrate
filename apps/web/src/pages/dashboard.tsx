// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";
import { useAgents } from "../hooks/use-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { useAllSchedules } from "../hooks/use-schedules";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { ErrorState } from "../components/page-states";
import { PackageCard } from "../components/package-card";
import { ScheduleCard } from "../components/schedule-card";
import { RunsTable, useRunColumns } from "../components/runs-table";
import { visibleColumns } from "../components/data-table";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useRunAgentName } from "../hooks/use-run-agent-name";

/** Rows shown under "recent runs" — a prefix of the page's own run query. */
const RECENT_RUNS_COUNT = 7;

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
  const agentName = useRunAgentName();
  // The same table, so the same preference: a column hidden on the runs page
  // is hidden in this card too.
  const allRunColumns = useRunColumns({ agentName });
  const runColumnVisibility = useColumnVisibility("runs");
  const runColumns = visibleColumns(allRunColumns, runColumnVisibility.hidden);
  const { data: schedules } = useAllSchedules();

  const isLoading = runsLoading || agentsLoading;
  const error = runsError || agentsError;

  const runs = runsData?.data ?? [];

  // Build agent lookup map
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
        displayName: f.display_name ?? f.id,
        description: f.description ?? null,
        source: f.source,
        keywords: f.keywords,
        running_runs: f.running_runs,
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
    .filter((s) => s.enabled !== false && s.next_run_at)
    .sort((a, b) => new Date(a.next_run_at!).getTime() - new Date(b.next_run_at!).getTime())
    .slice(0, 5);

  const firstName = (profile?.displayName || user?.name || "").split(/\s+/)[0];

  return (
    <div className="space-y-6">
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
        {/* Rendered from the runs THIS page already loaded. Mounting
            `<RunList pageSize={7}>` here instead issued a second
            `GET /api/runs` (a different `limit` is a different query key), and
            with it a second `COUNT` + enriched page read, for rows the 15 above
            already contain. The table takes rows, never a query, which is what
            makes that possible. */}
        {/* The states live in the table, not above the page. An early return
            here took the welcome line and every section with it, so the whole
            dashboard blinked out and back on every refetch; the table knows the
            shape of what is coming and holds it. */}
        <RunsTable
          runs={runs.slice(0, RECENT_RUNS_COUNT)}
          columns={runColumns}
          agentName={agentName}
          isLoading={isLoading}
          isError={Boolean(error)}
          error={<ErrorState message={error?.message} compact />}
        />
      </section>
    </div>
  );
}
