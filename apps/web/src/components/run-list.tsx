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
  /** Filter runs by lifecycle status — one, or several at once. */
  status?: RunStatus[];
  /**
   * The bar above the table, given the number of rows the filters left.
   *
   * A render prop rather than a `count` the page reads for itself: the query
   * lives here, and a page asking for the same rows a second time to count
   * them is the duplicate `GET /api/runs` the dashboard already had to be
   * cured of. The page still owns WHAT the bar says.
   */
  toolbar?: (total: number) => React.ReactNode;
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
  toolbar,
}: RunListProps) {
  const { t } = useTranslation(["agents"]);
  const agentName = useRunAgentName(fixedAgentName);

  // Paging resets when the filters change — WITHOUT remounting this component.
  // It used to be a `key` at the call site, which is the idiomatic way to reset
  // state; but the toolbar renders inside here, so remounting closed its open
  // menu on every tick and made multi-select unusable. The page is derived
  // from the filter set instead: a new set reads as page zero straight away.
  const signature = `${user ?? ""}|${kind ?? ""}|${status?.join(",") ?? ""}`;
  const [paging, setPaging] = useState({ signature, page: 0 });
  const page = paging.signature === signature ? paging.page : 0;
  const setPage = (next: number) => setPaging({ signature, page: next });

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
      {toolbar?.(total)}

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
              onClick={() => setPage(page - 1)}
              disabled={page === 0}
            >
              {t("pagination.previous", { ns: "common" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
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
