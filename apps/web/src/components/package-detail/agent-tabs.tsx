// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { usePackageDetail } from "../../hooks/use-packages";
import { MemoryPanel } from "../persistence/memory-panel";
import { useSchedules } from "../../hooks/use-schedules";
import { schemaHasFileFields } from "@appstrate/core/form";
import { usePermissions } from "../../hooks/use-permissions";
import { ScopedRunList } from "../scoped-run-list";
import { SchedulesTable } from "../schedules-table";
import { useScheduleColumns } from "../schedule-columns";
import { AgentRunButton } from "./agent-run-button";
import { Ban, CalendarClock, Play } from "lucide-react";
import { EmptyState, EmptyStateAction } from "../page-states";
import { TextSkeleton } from "../loading-skeletons";
import { ListToolbar, type FilterSpec } from "../list-toolbar";
import { runStatusValues } from "@appstrate/core/run-status";
import { readList, useLocalListParams } from "../../lib/list-params";
import { matchesSearch } from "../../lib/strings";
import { useModalParam } from "../../hooks/use-modal-param";
import { NEW_SCHEDULE_PARAM } from "../new-schedule-modal";
import { useConsumedSearchParam } from "../../hooks/use-consumed-search-param";

export function AgentRunsTab({
  packageId,
  versionLabel,
}: {
  packageId: string;
  versionLabel: string | undefined;
}) {
  const { t } = useTranslation(["agents", "common"]);
  // The overview's counters open this tab already filtered.
  const requestedStatus = useConsumedSearchParam("agentRunStatus");

  return (
    <ScopedRunList
      scope={{ packageId }}
      initialStatus={readList(requestedStatus, runStatusValues)}
      emptyState={
        <EmptyState message={t("detail.emptyRuns")} icon={Play} compact>
          {/* The header's launch control answers `?run`: this one only triggers it. */}
          <AgentRunButton packageId={packageId} versionLabel={versionLabel} inputDialog={false} />
        </EmptyState>
      }
    />
  );
}

export function AgentSchedulesTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const schedulesQuery = useSchedules(packageId);
  const schedules = schedulesQuery.data;
  const list = useLocalListParams();
  const states = list.values("state", ["active", "disabled"] as const);
  const columns = useScheduleColumns({ agentName: () => packageId, showAgentName: false });
  const { can } = usePermissions();
  const newSchedule = useModalParam(NEW_SCHEDULE_PARAM);

  if (!detail) return <TextSkeleton lines={3} />;

  if (schemaHasFileFields(detail.input?.schema)) {
    return <EmptyState message={t("schedule.fileInputBlocked")} icon={Ban} compact />;
  }

  const filteredSchedules = (schedules ?? []).filter((schedule) => {
    const state = schedule.enabled ? "active" : "disabled";
    const matchesState = states.length === 0 || states.includes(state);
    return (
      matchesState &&
      matchesSearch(list.search, [schedule.name ?? schedule.id, schedule.cron_expression])
    );
  });
  const filters: FilterSpec[] = [
    {
      id: "state",
      label: t("detail.schedulesTable.filterState"),
      values: states,
      options: [
        { value: "active", label: t("schedule.statusActive") },
        { value: "disabled", label: t("schedule.statusDisabled") },
      ],
      onChange: list.setValues("state"),
    },
  ];

  const hasSchedules = (schedules ?? []).length > 0;

  return (
    <>
      <ListToolbar
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: t("detail.schedulesTable.search"),
        }}
        filters={filters}
        onReset={list.reset}
      />
      <SchedulesTable
        schedules={filteredSchedules}
        columns={columns}
        surface="integrated"
        isLoading={schedulesQuery.isPending}
        isError={schedulesQuery.isError}
        empty={
          hasSchedules ? (
            <EmptyState message={t("detail.schedulesTable.noMatch")} icon={CalendarClock} compact />
          ) : (
            <EmptyState message={t("detail.emptySchedule")} icon={CalendarClock} compact>
              {can("schedules:write") && (
                <EmptyStateAction
                  action={{
                    label: t("schedule.titleNew"),
                    onSelect: () => newSchedule.open(packageId),
                  }}
                />
              )}
            </EmptyState>
          )
        }
      />
    </>
  );
}

export function AgentMemoryTab({ packageId }: { packageId: string }) {
  const requestedType = useConsumedSearchParam("agentMemory");
  const initialTypes: Array<"pinned" | "archive"> =
    requestedType === "pinned" || requestedType === "archive" ? [requestedType] : [];
  return <MemoryPanel packageId={packageId} initialTypes={initialTypes} />;
}
