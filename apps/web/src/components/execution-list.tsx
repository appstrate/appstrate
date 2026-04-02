// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePaginatedExecutions } from "../hooks/use-paginated-executions";
import { useProfiles } from "../hooks/use-profiles";
import { useAllSchedules } from "../hooks/use-schedules";
import { useFlows } from "../hooks/use-packages";
import { ExecutionRow } from "./execution-row";
import { EmptyState } from "./page-states";

interface ExecutionListProps {
  packageId?: string;
  scheduleId?: string;
  /** Fixed flow name — skips flow lookup when set (e.g. schedule detail) */
  fixedFlowName?: string;
  /** Fixed schedule name — skips schedule lookup when set */
  fixedScheduleName?: string | null;
  /** Items per page (default 20) */
  pageSize?: number;
  /** Show pagination controls (default true) */
  paginated?: boolean;
  /** Hide flow name column (when already in flow context) */
  hideFlowName?: boolean;
  /** Custom empty state (replaces default) */
  emptyState?: React.ReactNode;
  /** Preview row shown above the first page (e.g. scheduled next-run) */
  firstPageBanner?: React.ReactNode;
  /** Filter executions by user — "me" for current user only */
  user?: "me";
}

export function ExecutionList({
  packageId,
  scheduleId,
  fixedFlowName,
  fixedScheduleName,
  pageSize = 20,
  paginated = true,
  hideFlowName = false,
  emptyState,
  firstPageBanner,
  user,
}: ExecutionListProps) {
  const { t } = useTranslation(["flows"]);
  const [page, setPage] = useState(0);

  const { data, isLoading } = usePaginatedExecutions({
    packageId,
    scheduleId,
    user,
    limit: pageSize,
    offset: page * pageSize,
  });

  const executions = data?.executions ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  // Resolve user names
  const profileMap = useProfiles(
    executions.map((e) => e.userId).filter((id): id is string => !!id),
  );

  // Resolve flow names (skip if fixed or hidden)
  const { data: flows } = useFlows();
  const flowNameMap = new Map<string, string>();
  if (!hideFlowName && !fixedFlowName && flows) {
    for (const f of flows) {
      flowNameMap.set(f.id, f.displayName);
    }
  }

  // Resolve schedule names (skip if fixed)
  const { data: schedules } = useAllSchedules();

  if (isLoading && page === 0) {
    return (
      <div className="border-border text-muted-foreground rounded-md border p-8 text-center text-sm">
        {t("loading", { ns: "common" })}
      </div>
    );
  }

  if (executions.length === 0) {
    if (emptyState) return <>{emptyState}</>;
    return <EmptyState message={t("detail.emptyExec")} icon={PlayCircle} compact />;
  }

  const resolveFlowName = (exec: (typeof executions)[0]) => {
    if (hideFlowName) return undefined;
    if (fixedFlowName) return fixedFlowName;
    return flowNameMap.get(exec.packageId ?? "") ?? exec.packageId ?? "\u2014";
  };

  const resolveScheduleName = (exec: (typeof executions)[0]) => {
    if (!exec.scheduleId) return null;
    if (fixedScheduleName) return fixedScheduleName;
    return schedules?.find((s) => s.id === exec.scheduleId)?.name ?? null;
  };

  return (
    <div className="space-y-2">
      <div className="border-border rounded-md border">
        {page === 0 && firstPageBanner}
        {executions.map((exec) => (
          <ExecutionRow
            key={exec.id}
            execution={exec}
            flowName={resolveFlowName(exec)}
            userName={exec.userId ? profileMap.get(exec.userId) : undefined}
            scheduleName={resolveScheduleName(exec)}
          />
        ))}
      </div>

      {paginated && totalPages > 1 && (
        <div className="flex items-center justify-end gap-4 pt-1">
          <span className="text-muted-foreground text-sm">
            {t("pagination.pageOf", {
              page: page + 1,
              total: totalPages,
              ns: "common",
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p - 1)}
              disabled={page === 0}
            >
              {t("pagination.previous", { ns: "common" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages - 1}
            >
              {t("pagination.next", { ns: "common" })}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
