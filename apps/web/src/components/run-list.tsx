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
import { RunsTable, useRunColumns } from "./runs-table";
import { RunCard } from "./run-card";
import { CardGrid } from "./card-grid";
import { EmptyState } from "./page-states";
import { columnMenu, visibleColumns } from "./data-table";
import { useColumnVisibility } from "../stores/column-visibility-store";
import type { EnrichedRun, RunStatus } from "@appstrate/shared-types";
import { ListFooter, type ColumnMenuSpec } from "./list-toolbar";
import type { ListView } from "../stores/list-view-store";
import { PlayCircle } from "lucide-react";

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
  /** Free text: the agent a run executed, the error it ended on, its number. */
  search?: string;
  /**
   * The bar above the table.
   *
   * A render prop rather than props the page reads for itself: the columns live
   * here, and the bar's column menu has to name the same ones the table draws.
   * The page still owns WHAT the bar says.
   */
  toolbar?: (bar: { columns: ColumnMenuSpec }) => React.ReactNode;
  /**
   * What the list amounts to, under the table — IN THE CALLER'S OWN WORDS. A
   * render prop because the query lives here: a page asking for the same rows a
   * second time to count them is the duplicate `GET /api/runs` the dashboard
   * already had to be cured of.
   */
  countLabel?: (total: number) => React.ReactNode;
  /** Level-one Runs offers both representations; embedded run lists stay tables. */
  view?: ListView;
  /** Level-one tables preserve every selected column behind horizontal overflow. */
  tableColumnMode?: "tiered" | "scroll";
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
  search,
  toolbar,
  countLabel,
  view = "table",
  tableColumnMode = "tiered",
}: RunListProps) {
  const { t } = useTranslation(["agents"]);
  const agentName = useRunAgentName(fixedAgentName);
  const allColumns = useRunColumns({ agentName, hideAgentName });
  // Per TABLE, not per screen: the run list keeps its columns wherever it is
  // shown — the runs page, an agent's tab, a schedule's history.
  const visibility = useColumnVisibility("runs");
  const columns = visibleColumns(allColumns, visibility.hidden);

  // Paging resets when the filters change — WITHOUT remounting this component.
  // It used to be a `key` at the call site, which is the idiomatic way to reset
  // state; but the toolbar renders inside here, so remounting closed its open
  // menu on every tick and made multi-select unusable. The page is derived
  // from the filter set instead: a new set reads as page zero straight away.
  const signature = `${user ?? ""}|${kind ?? ""}|${status?.join(",") ?? ""}|${search ?? ""}`;
  const [paging, setPaging] = useState({ signature, page: 0 });
  const page = paging.signature === signature ? paging.page : 0;
  const setPage = (next: number) => setPaging({ signature, page: next });

  const { data, isLoading, isError } = usePaginatedRuns({
    packageId,
    scheduleId,
    user,
    kind,
    status,
    search,
    limit: pageSize,
    offset: page * pageSize,
  });

  const runs: EnrichedRun[] = data?.data ?? [];
  // Undefined until the request answers — the count and the pager both read
  // it, and `?? 0` here used to tell the footer there were zero runs on a 500.
  const total = data?.total;
  const totalPages = total === undefined ? 0 : Math.ceil(total / pageSize);

  // Only the first page shows a placeholder; paging keeps the previous rows.
  const showLoading = isLoading && page === 0;

  return (
    <div>
      {toolbar?.({ columns: columnMenu(allColumns, visibility) })}

      {view === "table" ? (
        <RunsTable
          runs={runs}
          columns={columns}
          agentName={agentName}
          isLoading={showLoading}
          isError={isError}
          empty={emptyState}
          banner={page === 0 ? firstPageBanner : undefined}
          columnMode={tableColumnMode}
        />
      ) : (
        <CardGrid
          items={runs}
          itemKey={(run) => run.id}
          renderCard={(run) => <RunCard run={run} agentName={agentName(run)} />}
          isLoading={showLoading}
          isError={isError}
          empty={
            emptyState ?? <EmptyState message={t("detail.emptyRuns")} icon={PlayCircle} compact />
          }
        />
      )}

      {/* The count speaks only for an answer we actually have: it read "0 run"
          while the first page was still loading and, worse, on a 500 — the same
          lie the empty state had to be cured of. */}
      <ListFooter count={total === undefined ? undefined : countLabel?.(total)}>
        {paginated && totalPages > 1 && (
          <>
            <span>
              {t("pagination.pageOf", {
                page: page + 1,
                total: totalPages,
                ns: "common",
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setPage(page - 1)}
              disabled={page === 0}
            >
              {t("pagination.previous", { ns: "common" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages - 1}
            >
              {t("pagination.next", { ns: "common" })}
            </Button>
          </>
        )}
      </ListFooter>
    </div>
  );
}
