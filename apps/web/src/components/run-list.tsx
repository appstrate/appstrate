// SPDX-License-Identifier: Apache-2.0

/**
 * A page of runs: the query, the paging, and the table underneath.
 *
 * It used to have a presentation half of its own (`RunRows`) that resolved
 * agent names, picked the empty state and then delegated. Both halves of that
 * job moved to where they belong when the list became a table — the naming to
 * `use-run-agent-name.ts`, the states into `RunsTable` — so what is left here
 * is fetching, which is all this component was ever about.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { usePaginatedRuns, type RunKindFilter } from "../hooks/use-paginated-runs";
import { useRunAgentName } from "../hooks/use-run-agent-name";
import { RunsTable } from "./runs-table";
import type { EnrichedRun, RunStatus } from "@appstrate/shared-types";

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
  /** Filter runs by kind -- "all" | "package" | "inline" */
  kind?: RunKindFilter;
  /** Filter runs by lifecycle status. */
  status?: RunStatus;
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
  kind,
  status,
}: RunListProps) {
  const { t } = useTranslation(["agents"]);
  const [page, setPage] = useState(0);
  const agentName = useRunAgentName(fixedAgentName);

  const { data, isLoading, isError } = usePaginatedRuns({
    packageId,
    scheduleId,
    user,
    kind,
    status,
    limit: pageSize,
    offset: page * pageSize,
  });

  const runs: EnrichedRun[] = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  // Only the first page shows a placeholder; paging keeps the previous rows.
  const showLoading = isLoading && page === 0;

  return (
    <div className="space-y-2">
      <RunsTable
        runs={runs}
        agentName={agentName}
        hideAgentName={hideAgentName}
        isLoading={showLoading}
        isError={isError}
        empty={emptyState}
        banner={page === 0 ? firstPageBanner : undefined}
      />

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
