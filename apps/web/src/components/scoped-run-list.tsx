// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RunStatus } from "@appstrate/core/run-status";
import { RunList } from "./run-list";
import { ListToolbar } from "./list-toolbar";
import { NoMatchState } from "./page-states";
import { useLocalListParams } from "../lib/list-params";
import { useRunStatusFilter } from "../hooks/use-run-status-filter";
import { useSearchPlaceholder } from "../lib/search-placeholder";

/** One agent's runs (its name is the page's), or one schedule's (named once for every row). */
type RunScope = { packageId: string } | { scheduleId: string; agentName: string };

/**
 * The runs of one agent or one schedule, in a detail panel: the same columns,
 * page size and count as the runs page, with search and status filter held by
 * the panel itself. A filtered list that finds nothing offers to clear the
 * filters rather than the panel's own empty state.
 */
export function ScopedRunList({
  scope,
  initialStatus,
  banner,
  emptyState,
}: {
  scope: RunScope;
  initialStatus?: RunStatus[];
  /** Row above the first page, and above `emptyState`; shown only while nothing is filtered. */
  banner?: ReactNode;
  /** The panel's empty state when nothing is filtered. */
  emptyState: ReactNode;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const list = useLocalListParams(initialStatus ? { status: initialStatus } : undefined);
  const { statuses, filter: statusFilter } = useRunStatusFilter(list);
  const filtered = !!list.search || statuses.length > 0;
  const searchPlaceholder = useSearchPlaceholder(t("common:nav.runs"));

  return (
    <RunList
      {...("packageId" in scope
        ? { packageId: scope.packageId }
        : { scheduleId: scope.scheduleId, fixedAgentName: scope.agentName })}
      status={statuses}
      search={list.search}
      tableSurface="integrated"
      countLabel={(total) => t("runs.count", { count: total })}
      toolbar={({ columns }) => (
        <ListToolbar
          columns={columns}
          search={{
            value: list.search,
            onChange: list.setSearch,
            placeholder: searchPlaceholder,
          }}
          filters={[statusFilter]}
          onReset={list.reset}
        />
      )}
      banner={filtered ? null : banner}
      emptyState={
        filtered ? (
          <NoMatchState message={t("runs.emptyFiltered")} onReset={list.reset} />
        ) : (
          <>
            {banner}
            {emptyState}
          </>
        )
      }
    />
  );
}
