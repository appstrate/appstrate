// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { usePackageDetail } from "../../hooks/use-packages";
import { MemoryPanel } from "../persistence/memory-panel";
import { useSchedules } from "../../hooks/use-schedules";
import { schemaHasFileFields } from "@appstrate/core/form";
import { usePermissions } from "../../hooks/use-permissions";
import { RunList } from "../run-list";
import { SchedulesTable, useScheduleColumns } from "../schedules-table";
import { AgentRunButton } from "./agent-run-button";
import { Ban, CalendarClock, Play, SearchX } from "lucide-react";
import { EmptyState, EmptyStateAction } from "../page-states";
import { ListToolbar, type FilterSpec } from "../list-toolbar";
import { runStatusValues, type RunStatus } from "@appstrate/core/run-status";
import { useModalParam } from "../../hooks/use-modal-param";
import { NEW_SCHEDULE_PARAM } from "../new-schedule-modal";

export function AgentRunsTab({
  packageId,
  versionLabel,
}: {
  packageId: string;
  versionLabel: string | undefined;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const location = useLocation();
  const requestedStatus = new URLSearchParams(location.search).get("agentRunStatus");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<RunStatus[]>(() =>
    (requestedStatus?.split(",") ?? []).filter((value): value is RunStatus =>
      runStatusValues.includes(value as RunStatus),
    ),
  );
  const filters: FilterSpec[] = [
    {
      id: "status",
      label: t("runs.filterStatus"),
      values: statuses,
      options: runStatusValues.map((value) => ({
        value,
        label: t(`status.${value}`, { ns: "common" }),
      })),
      onChange: (values) => setStatuses(values as RunStatus[]),
    },
  ];

  return (
    <RunList
      packageId={packageId}
      pageSize={12}
      status={statuses}
      search={search}
      hideAgentName
      tableSurface="integrated"
      toolbar={() => (
        <ListToolbar
          placement="panel"
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t("detail.runsSearch"),
          }}
          filters={filters}
          onReset={() => {
            setSearch("");
            setStatuses([]);
          }}
        />
      )}
      emptyState={
        search || statuses.length > 0 ? (
          <EmptyState message={t("runs.emptyFiltered")} icon={SearchX} compact />
        ) : (
          <EmptyState message={t("detail.emptyRuns")} icon={Play} compact>
            <AgentRunButton packageId={packageId} versionLabel={versionLabel} />
          </EmptyState>
        )
      }
    />
  );
}

export function AgentSchedulesTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: schedules } = useSchedules(packageId);
  const [search, setSearch] = useState("");
  const [states, setStates] = useState<string[]>([]);
  const columns = useScheduleColumns({ agentName: () => packageId, showAgentName: false });
  const { can } = usePermissions();
  const newSchedule = useModalParam(NEW_SCHEDULE_PARAM);

  if (!detail) return null;

  if (schemaHasFileFields(detail.input?.schema)) {
    return <EmptyState message={t("schedule.fileInputBlocked")} icon={Ban} compact />;
  }

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredSchedules = (schedules ?? []).filter((schedule) => {
    const state = schedule.enabled ? "active" : "disabled";
    const matchesState = states.length === 0 || states.includes(state);
    const matchesSearch =
      normalizedSearch === "" ||
      (schedule.name ?? schedule.id).toLocaleLowerCase().includes(normalizedSearch) ||
      schedule.cron_expression.toLocaleLowerCase().includes(normalizedSearch);
    return matchesState && matchesSearch;
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
      onChange: setStates,
    },
  ];

  return (
    <>
      {!schedules || schedules.length === 0 ? (
        <EmptyState message={t("detail.emptySchedule")} icon={CalendarClock} compact>
          {can("schedules:write") && (
            <EmptyStateAction
              label={t("schedule.titleNew")}
              onClick={() => newSchedule.open(packageId)}
            />
          )}
        </EmptyState>
      ) : (
        <>
          <ListToolbar
            placement="panel"
            search={{
              value: search,
              onChange: setSearch,
              placeholder: t("detail.schedulesTable.search"),
            }}
            filters={filters}
            onReset={() => {
              setSearch("");
              setStates([]);
            }}
          />
          <SchedulesTable
            schedules={filteredSchedules}
            columns={columns}
            columnMode="scroll"
            surface="integrated"
            empty={
              <EmptyState
                message={t("detail.schedulesTable.noMatch")}
                icon={CalendarClock}
                compact
              />
            }
          />
        </>
      )}
    </>
  );
}

export function AgentMemoryTab({ packageId }: { packageId: string }) {
  const location = useLocation();
  const requestedType = new URLSearchParams(location.search).get("agentMemory");
  const initialTypes: Array<"pinned" | "archive"> =
    requestedType === "pinned" || requestedType === "archive" ? [requestedType] : [];
  return <MemoryPanel packageId={packageId} initialTypes={initialTypes} />;
}
