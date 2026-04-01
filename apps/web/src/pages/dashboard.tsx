import { Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";
import { useFlows } from "../hooks/use-packages";
import { useUnreadCountsByFlow } from "../hooks/use-notifications";
import { useAllSchedules } from "../hooks/use-schedules";
import { usePaginatedExecutions } from "../hooks/use-paginated-executions";
import { LoadingState, ErrorState } from "../components/page-states";
import { PackageCard } from "../components/package-card";
import { ScheduleCard } from "../components/schedule-card";
import { ExecutionList } from "../components/execution-list";

export function DashboardPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { profile, user } = useAuth();
  const {
    data: execData,
    isLoading: execLoading,
    error: execError,
  } = usePaginatedExecutions({
    limit: 15,
    offset: 0,
  });
  const { data: flows, isLoading: flowsLoading, error: flowsError } = useFlows();
  const { data: unreadCounts } = useUnreadCountsByFlow();
  const { data: schedules } = useAllSchedules();

  const isLoading = execLoading || flowsLoading;
  const error = execError || flowsError;

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const executions = execData?.executions ?? [];

  // No executions → redirect to flows page
  if (executions.length === 0) {
    return <Navigate to="/flows" replace />;
  }

  // Build flow lookup map
  const flowMap = new Map<
    string,
    {
      displayName: string;
      description?: string | null;
      source?: string;
      keywords?: string[];
      providerIds?: string[];
      runningExecutions?: number;
    }
  >();
  if (flows) {
    for (const f of flows) {
      flowMap.set(f.id, {
        displayName: f.displayName,
        description: f.description,
        source: f.source,
        keywords: f.keywords,
        providerIds: f.dependencies.providers,
        runningExecutions: f.runningExecutions,
      });
    }
  }

  // Deduplicate executions by packageId (keep first = most recent), limit to 8
  // Only include flows that still exist (flowMap lookup)
  const recentFlowIds: string[] = [];
  const seen = new Set<string>();
  for (const exec of executions) {
    if (!exec.packageId || seen.has(exec.packageId)) continue;
    seen.add(exec.packageId);
    if (flowMap.has(exec.packageId)) {
      recentFlowIds.push(exec.packageId);
    }
    if (recentFlowIds.length >= 8) break;
  }

  // Upcoming schedules: active, with nextRunAt, sorted by soonest first
  const upcomingSchedules = (schedules ?? [])
    .filter((s) => s.enabled !== false && s.nextRunAt)
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime())
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
                flowName={flowMap.get(sched.packageId)?.displayName}
              />
            ))}
          </div>
        </section>
      )}

      {/* Recent flows (horizontal scroll) */}
      {recentFlowIds.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t("dashboard.recentFlows")}
            </h2>
            <Link
              to="/flows"
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            >
              {t("dashboard.seeAll")}
            </Link>
          </div>
          <div className="flex items-stretch gap-3 overflow-x-auto pb-2">
            {recentFlowIds.map((flowId) => {
              const flow = flowMap.get(flowId);
              return (
                <div key={flowId} className="flex max-w-[300px] min-w-[260px] shrink-0">
                  <PackageCard
                    id={flowId}
                    displayName={flow?.displayName ?? flowId}
                    description={flow?.description}
                    type="flow"
                    source={flow?.source as "system" | "local" | undefined}
                    runningExecutions={flow?.runningExecutions}
                    keywords={flow?.keywords}
                    providerIds={flow?.providerIds}
                    unreadCount={unreadCounts?.[flowId]}
                  />
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Recent executions */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-muted-foreground text-sm font-medium">
            {t("dashboard.recentExecutions")}
          </h2>
          <Link
            to="/executions"
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            {t("dashboard.seeAll")}
          </Link>
        </div>
        <ExecutionList pageSize={7} paginated={false} />
      </section>
    </div>
  );
}
