// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RunList } from "./run-list";
import { ListToolbar } from "./list-toolbar";
import { NoMatchState } from "./page-states";
import { useLocalListParams, type ListState } from "../lib/list-params";
import { useRunStatusFilter } from "../hooks/use-run-status-filter";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useOverviewMode } from "../hooks/use-overview-mode";

/** One agent's runs (its name is the page's), or one schedule's (named once for every row). */
type RunScope = { packageId: string } | { scheduleId: string; agentName: string };

/**
 * The runs of one agent or one schedule, in a detail panel: the same columns,
 * page size and count as the runs page, with search and status filter held by
 * the panel itself. A filtered list that finds nothing offers to clear the
 * filters rather than the panel's own empty state. In « Tous les espaces » an agent's runs are
 * those of every space the reader reaches, each row naming its space, as on the runs page; a
 * schedule's stay its space's.
 */
export function ScopedRunList({
  scope,
  list: panelList,
  banner,
  emptyState,
}: {
  scope: RunScope;
  list?: ListState;
  /** Row above the first page, and above `emptyState`; shown only while nothing is filtered. */
  banner?: ReactNode;
  /** The panel's empty state when nothing is filtered. */
  emptyState: ReactNode;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const local = useLocalListParams();
  const list = panelList ?? local;
  const { statuses, filter: statusFilter } = useRunStatusFilter(list);
  const filtered = !!list.search || statuses.length > 0;
  const searchPlaceholder = useSearchPlaceholder(t("common:nav.runs"));
  const { on: overview } = useOverviewMode();

  return (
    <RunList
      {...("packageId" in scope
        ? { packageId: scope.packageId, spanning: overview }
        : { scheduleId: scope.scheduleId, fixedAgentName: scope.agentName })}
      status={statuses}
      search={list.search}
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
