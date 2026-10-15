// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RunStatus } from "@appstrate/core/run-status";
import { RunList } from "./run-list";
import { ListToolbar } from "./list-toolbar";
import { NoMatchState } from "./page-states";
import { useLocalListParams } from "../lib/list-params";
import { useRunStatusFilter } from "../hooks/use-run-status-filter";

/** One agent's runs (its name is the page's), or one schedule's (named once for every row). */
type RunScope = { packageId: string } | { scheduleId: string; agentName: string };

/**
 * The runs of one agent or one schedule, in a detail panel: search and status
 * filter held by the panel itself, and a filtered list that finds nothing
 * offers to clear the filters rather than the panel's own empty state.
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

  return (
    <RunList
      {...("packageId" in scope
        ? { packageId: scope.packageId, hideAgentName: true }
        : { scheduleId: scope.scheduleId, fixedAgentName: scope.agentName })}
      pageSize={12}
      status={statuses}
      search={list.search}
      tableSurface="integrated"
      toolbar={({ columns }) => (
        <ListToolbar
          placement="panel"
          columns={columns}
          search={{
            value: list.search,
            onChange: list.setSearch,
            placeholder: t("detail.runsSearch"),
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
