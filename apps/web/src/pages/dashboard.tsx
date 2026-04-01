import { Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";
import { useFlows } from "../hooks/use-packages";
import { useAllExecutions, useUnreadCountsByFlow } from "../hooks/use-notifications";
import { useProfiles } from "../hooks/use-profiles";
import { useAllSchedules } from "../hooks/use-schedules";
import { LoadingState, ErrorState } from "../components/page-states";
import { PackageCard } from "../components/package-card";
import { ExecutionRow } from "../components/execution-row";
import type { Execution } from "@appstrate/shared-types";

export function DashboardPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { profile, user } = useAuth();
  const { data: execData, isLoading: execLoading, error: execError } = useAllExecutions(0, 20);
  const { data: flows, isLoading: flowsLoading, error: flowsError } = useFlows();
  const { data: unreadCounts } = useUnreadCountsByFlow();
  const { data: schedules } = useAllSchedules();

  const executions = execData?.executions ?? [];
  const profileMap = useProfiles(
    executions
      .slice(0, 15)
      .map((e) => e.userId)
      .filter((id): id is string => !!id),
  );

  const isLoading = execLoading || flowsLoading;
  const error = execError || flowsError;

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

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
  const recentFlowIds: string[] = [];
  const seen = new Set<string>();
  for (const exec of executions) {
    if (!exec.packageId || seen.has(exec.packageId)) continue;
    seen.add(exec.packageId);
    recentFlowIds.push(exec.packageId);
    if (recentFlowIds.length >= 8) break;
  }

  // Flow name map for execution rows
  const flowNameMap = new Map<string, string>();
  if (flows) {
    for (const f of flows) {
      flowNameMap.set(f.id, f.displayName);
    }
  }

  const recentExecutions = executions.slice(0, 15);

  // No executions → redirect to flows page
  if (executions.length === 0) {
    return <Navigate to="/flows" replace />;
  }

  const firstName = (profile?.displayName || user?.name || "").split(/\s+/)[0];

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">
        {t("dashboard.welcome", { name: firstName, ns: "common" })}
      </h1>
      {/* Recent flows (horizontal scroll) */}
      {recentFlowIds.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {t("dashboard.recentFlows")}
            </h2>
            <Link
              to="/flows"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("dashboard.seeAll")}
            </Link>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2 items-stretch">
            {recentFlowIds.map((flowId) => {
              const flow = flowMap.get(flowId);
              return (
                <div key={flowId} className="min-w-[260px] max-w-[300px] shrink-0 flex">
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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("dashboard.recentExecutions")}
          </h2>
          <Link
            to="/executions"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("dashboard.seeAll")}
          </Link>
        </div>
        <div className="rounded-md border border-border">
          {recentExecutions.map((exec: Execution) => (
            <ExecutionRow
              key={exec.id}
              execution={exec}
              flowName={flowNameMap.get(exec.packageId ?? "") ?? exec.packageId ?? "\u2014"}
              userName={exec.userId ? profileMap.get(exec.userId) : undefined}
              scheduleName={
                exec.scheduleId
                  ? (schedules?.find((s) => s.id === exec.scheduleId)?.name ?? null)
                  : null
              }
            />
          ))}
        </div>
      </section>
    </div>
  );
}
