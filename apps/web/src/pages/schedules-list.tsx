// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Calendar, Plus, SearchX } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { PageHeader } from "../components/page-header";
import { EmptyState } from "../components/page-states";
import { SchedulesTable, useScheduleColumns } from "../components/schedules-table";
import { ScheduleCard } from "../components/schedule-card";
import { CardGrid } from "../components/card-grid";
import { columnMenu, visibleColumns } from "../components/data-table";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { TOOLBAR_ACTION } from "../lib/toolbar-button";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useListParams } from "../lib/list-params";
import { useScheduleViewStore } from "../stores/list-view-store";

/** The values the state dimension accepts — a URL is user input. */
const STATES = ["enabled", "disabled"] as const;

export function SchedulesListPage() {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();
  const { data: schedules, isLoading, isError } = useAllSchedules();
  const { data: agents } = useAgents();
  const placeholder = useSearchPlaceholder(t("schedules.title"));
  const view = useScheduleViewStore((state) => state.view);
  const setView = useScheduleViewStore((state) => state.setView);

  const create = (
    <Button
      variant="outline"
      size="sm"
      className={TOOLBAR_ACTION}
      title={t("schedules.create")}
      onClick={() => navigate("/schedules/new")}
    >
      <Plus />
      <span className="hidden sm:inline">{t("schedules.create")}</span>
    </Button>
  );

  // The same cached agents query every other surface holds, keyed by package id.
  const agentName = (packageId: string) =>
    agents?.find((a) => a.id === packageId)?.display_name ?? packageId;

  const allColumns = useScheduleColumns({
    agentName: (schedule) => agentName(schedule.packageId),
  });
  const visibility = useColumnVisibility("schedules");
  const columns = visibleColumns(allColumns, visibility.hidden);

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
    const q = query.trim().toLowerCase();
    return (schedules ?? []).filter((schedule) => {
      const enabled = schedule.enabled ?? true;
      const key = enabled ? "enabled" : "disabled";
      if (states.length > 0 && !states.includes(key)) return false;
      if (!q) return true;
      return (
        (schedule.name ?? "").toLowerCase().includes(q) ||
        agentName(schedule.packageId).toLowerCase().includes(q)
      );
    });
  }, [schedules, query, states, agents]);

  const filtering = query.trim() !== "" || states.length > 0;
  const emptyBody = filtering ? (
    <EmptyState message={t("schedules.noMatch")} icon={SearchX} compact />
  ) : (
    <EmptyState
      message={t("schedules.empty")}
      hint={t("schedules.emptyHint")}
      icon={Calendar}
      compact
    />
  );

  return (
    <div>
      <PageHeader
        title={t("schedules.title")}
        emoji="📅"
        breadcrumbs={[{ label: t("schedules.title") }]}
        actions={isAdmin ? create : undefined}
      />

      <ListToolbar
        search={{ value: query, onChange: list.setSearch, placeholder }}
        filters={[
          {
            id: "state",
            label: t("schedules.column.state"),
            values: states,
            onChange: list.setValues("state"),
            options: [
              { value: "enabled", label: t("schedule.statusActive", { ns: "agents" }) },
              { value: "disabled", label: t("schedule.statusDisabled", { ns: "agents" }) },
            ],
          },
        ]}
        onReset={list.reset}
        columns={view === "table" ? columnMenu(allColumns, visibility) : undefined}
        view={view}
        onViewChange={setView}
      />

      {view === "table" ? (
        <SchedulesTable
          schedules={shown}
          columns={columns}
          isLoading={isLoading}
          isError={isError}
          // A list nobody filtered and a filter that matched nothing are two
          // different sentences. The bar stays in either case.
          empty={emptyBody}
        />
      ) : (
        <CardGrid
          items={shown}
          itemKey={(schedule) => schedule.id}
          renderCard={(schedule) => (
            <ScheduleCard
              schedule={schedule}
              agentName={agentName(schedule.packageId)}
              variant="collection"
            />
          )}
          isLoading={isLoading}
          isError={isError}
          empty={emptyBody}
        />
      )}
      <ListFooter
        count={isLoading || isError ? undefined : t("schedules.count", { count: shown.length })}
      />
    </div>
  );
}
