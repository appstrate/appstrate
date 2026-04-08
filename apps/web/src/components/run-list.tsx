// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { useAgents } from "../hooks/use-packages";
import { RunRow } from "./run-row";
import { EmptyState } from "./page-states";
import type { EnrichedRun } from "@appstrate/shared-types";

interface RunListProps {
  packageId?: string;
  scheduleId?: string;
  /** Fixed agent name -- skips agent lookup when set (e.g. schedule detail) */
  fixedAgentName?: string;
  /** Items per page (default 20) */
  pageSize?: number;
  /** Show pagination controls (default true) */
  paginated?: boolean;
  /** Hide agent name column (when already in agent context) */
  hideAgentName?: boolean;
  /** Custom empty state (replaces default) */
  emptyState?: React.ReactNode;
  /** Preview row shown above the first page (e.g. scheduled next-run) */
  firstPageBanner?: React.ReactNode;
  /** Filter runs by user -- "me" for current user only */
  user?: "me";
}

export function RunList({
  packageId,
  scheduleId,
  fixedAgentName,
  pageSize = 20,
  paginated = true,
  hideAgentName = false,
  emptyState,
  firstPageBanner,
  user,
}: RunListProps) {
  const { t } = useTranslation(["agents"]);
  const [page, setPage] = useState(0);

  const { data, isLoading } = usePaginatedRuns({
    packageId,
    scheduleId,
    user,
    limit: pageSize,
    offset: page * pageSize,
  });

  const runs = (data?.runs ?? []) as EnrichedRun[];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  // Resolve agent names (skip if fixed or hidden)
  const { data: agents } = useAgents();
  const agentNameMap = new Map<string, string>();
  if (!hideAgentName && !fixedAgentName && agents) {
    for (const f of agents) {
      agentNameMap.set(f.id, f.displayName);
    }
  }

  if (isLoading && page === 0) {
    return (
      <div className="border-border text-muted-foreground rounded-md border p-8 text-center text-sm">
        {t("loading", { ns: "common" })}
      </div>
    );
  }

  if (runs.length === 0) {
    if (emptyState) return <>{emptyState}</>;
    return <EmptyState message={t("detail.emptyRuns")} icon={PlayCircle} compact />;
  }

  const resolveAgentName = (run: EnrichedRun) => {
    if (hideAgentName) return undefined;
    if (fixedAgentName) return fixedAgentName;
    return agentNameMap.get(run.packageId ?? "") ?? run.packageId ?? "\u2014";
  };

  return (
    <div className="space-y-2">
      <div className="border-border rounded-md border">
        {page === 0 && firstPageBanner}
        {runs.map((run) => (
          <RunRow key={run.id} run={run} agentName={resolveAgentName(run)} />
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
