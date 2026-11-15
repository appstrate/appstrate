// SPDX-License-Identifier: Apache-2.0

import { useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Calendar } from "lucide-react";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { useSpaceFilter, type SpaceDefault } from "../hooks/use-space-filter";
import { isQueryInFlight } from "../lib/query-state";
import { EmptyState, EmptyStateAction, ErrorState, NoMatchState } from "./page-states";
import { SchedulesTable } from "./schedules-table";
import { useScheduleColumns } from "./schedule-columns";
import { ListFooter, ListToolbar } from "./list-toolbar";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useListParams } from "../lib/list-params";
import { LIST_ADMITS } from "../lib/space-lists";
import { matchesSearch } from "../lib/strings";
import type { MenuAction } from "../lib/menu-action";

/** The values the state dimension accepts — a URL is user input. */
const STATES = ["enabled", "disabled"] as const;

/**
 * The schedules list with its bar: the Schedules page's (current space, `createAction` in its
 * empty state) and the overview's (every space, read-only).
 */
export function SchedulesCollection({
  spaceDefault,
  createAction,
}: {
  spaceDefault: SpaceDefault;
  createAction?: MenuAction;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const list = useListParams(["state"]);
  const { spaceIds, scope } = useSpaceFilter(LIST_ADMITS.schedules, spaceDefault);
  const { data: schedules, isLoading, isError, error } = useAllSchedules(spaceIds);
  const agentsQuery = useAgents();
  const { data: agents } = agentsQuery;
  const agentsPending = isQueryInFlight(agentsQuery);
  const placeholder = useSearchPlaceholder(t("common:nav.schedules"));

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
    spanning: spaceIds.length > 0,
  });
  const { columns, menu } = useColumnVisibility("schedules", allColumns);

  // Client-side, and honestly so: `GET /api/schedules` returns the list whole,
  // with no paging and no query parameters, so the box searches every schedule
  // rather than the page on screen — the same test the package lists pass and
  // the run list fails, which is why the run list waited for a `q`.
  //
  // The state still rides in the URL, like the runs page: a filtered list is
  // what people paste to each other, whoever does the filtering.
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
  ) : createAction ? (
    <EmptyState
      message={t("schedules.empty")}
      hint={t("schedules.emptyHint")}
      icon={Calendar}
      compact
    >
      <EmptyStateAction action={createAction} />
    </EmptyState>
  ) : (
    <EmptyState message={t("schedules.empty")} icon={Calendar} compact />
  );

  return (
    <>
      <ListToolbar
        search={{ value: query, onChange: list.setSearch, placeholder }}
        scope={scope}
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
    </>
  );
}
