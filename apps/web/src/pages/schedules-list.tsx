// SPDX-License-Identifier: Apache-2.0

import { useMemo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, Plus } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { isQueryInFlight } from "../lib/query-state";
import { PageHeader } from "../components/page-header";
import { EmptyState, EmptyStateAction, ErrorState, NoMatchState } from "../components/page-states";
import { SchedulesTable } from "../components/schedules-table";
import { useScheduleColumns } from "../components/schedule-columns";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useListParams } from "../lib/list-params";
import { matchesSearch } from "../lib/strings";
import { PageActionsMenu } from "../components/page-actions-menu";
import type { MenuAction } from "../lib/menu-action";
import { NewScheduleModal } from "../components/new-schedule-modal";

/** The values the state dimension accepts — a URL is user input. */
const STATES = ["enabled", "disabled"] as const;

export function SchedulesListPage() {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { can } = usePermissions();
  const [newScheduleOpen, setNewScheduleOpen] = useState(false);
  const { data: schedules, isLoading, isError, error } = useAllSchedules();
  const agentsQuery = useAgents();
  const { data: agents } = agentsQuery;
  const agentsPending = isQueryInFlight(agentsQuery);
  const placeholder = useSearchPlaceholder(t("common:nav.schedules"));

  const createAction: MenuAction = {
    id: "create",
    label: t("schedules.create"),
    icon: Plus,
    onSelect: () => setNewScheduleOpen(true),
    hidden: !can("schedules:write"),
  };

  // The same cached agents query every other surface holds, keyed by package id.
  // Memoised on `agents` so the filter below can depend on the lookup itself
  // rather than on the array it closes over — a fresh function each render
  // would defeat the `useMemo` it is a dependency of.
  const agentName = useCallback(
    (packageId: string) => agents?.find((a) => a.id === packageId)?.display_name ?? packageId,
    [agents],
  );

  const allColumns = useScheduleColumns({
    agentName: (schedule) => agentName(schedule.packageId),
    agentPending: agentsPending,
  });
  const { columns, menu } = useColumnVisibility("schedules", allColumns);

  // Client-side, and honestly so: `GET /api/schedules` returns the list whole,
  // with no paging and no query parameters, so the box searches every schedule
  // rather than the page on screen — the same test the package lists pass and
  // the run list fails, which is why the run list waited for a `q`.
  //
  // The state still rides in the URL, like the runs page: a filtered list is
  // what people paste to each other, whoever does the filtering.
  const list = useListParams(["state"]);
  const query = list.search;
  const states = list.values("state", STATES);
  const shown = useMemo(() => {
    return (schedules ?? []).filter((schedule) => {
      const enabled = schedule.enabled ?? true;
      const key = enabled ? "enabled" : "disabled";
      if (states.length > 0 && !states.includes(key)) return false;
      return matchesSearch(query, [schedule.name, agentName(schedule.packageId)]);
    });
  }, [schedules, query, states, agentName]);

  const filtering = query.trim() !== "" || states.length > 0;
  const emptyBody = filtering ? (
    <NoMatchState message={t("schedules.noMatch")} />
  ) : (
    <EmptyState
      message={t("schedules.empty")}
      hint={t("schedules.emptyHint")}
      icon={Calendar}
      compact
    >
      <EmptyStateAction action={createAction} />
    </EmptyState>
  );

  return (
    <div>
      <PageHeader
        title={t("common:nav.schedules")}
        variant="collection"
        breadcrumbs={[{ label: t("common:nav.schedules") }]}
        actions={can("schedules:write") ? <PageActionsMenu actions={[createAction]} /> : undefined}
      />

      <ListToolbar
        search={{ value: query, onChange: list.setSearch, placeholder }}
        filters={[
          {
            id: "state",
            label: t("providers.col.state"),
            values: states,
            onChange: list.setValues("state"),
            options: [
              { value: "enabled", label: t("schedule.statusActive", { ns: "agents" }) },
              { value: "disabled", label: t("schedule.statusDisabled", { ns: "agents" }) },
            ],
          },
        ]}
        onReset={list.reset}
        columns={menu}
      />

      <SchedulesTable
        schedules={shown}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
        error={<ErrorState error={error} compact />}
        // A list nobody filtered and a filter that matched nothing are two
        // different sentences. The bar stays in either case.
        empty={emptyBody}
      />
      <ListFooter
        count={isLoading || isError ? undefined : t("schedules.count", { count: shown.length })}
      />
      {newScheduleOpen && <NewScheduleModal onClose={() => setNewScheduleOpen(false)} />}
    </div>
  );
}
