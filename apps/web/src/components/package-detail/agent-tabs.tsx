// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePackageDetail } from "../../hooks/use-packages";
import { MemoryPanel } from "../persistence/memory-panel";
import { useSchedules } from "../../hooks/use-schedules";
import { schemaHasFileFields } from "@appstrate/core/form";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useAgentSpaceAction } from "../../hooks/use-agent-run-space";
import { ScopedRunList } from "../scoped-run-list";
import { SchedulesTable } from "../schedules-table";
import { useScheduleColumns } from "../schedule-columns";
import { AgentRunButton } from "./agent-run-button";
import { Ban, CalendarClock, Play } from "lucide-react";
import { EmptyState, EmptyStateAction, NoMatchState } from "../page-states";
import { ListToolbar, type FilterSpec } from "../list-toolbar";
import { runStatusValues } from "@appstrate/core/run-status";
import { readList, useLocalListParams } from "../../lib/list-params";
import { matchesSearch } from "../../lib/strings";
import { NewScheduleModal } from "../new-schedule-modal";
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
          <AgentRunButton packageId={packageId} versionLabel={versionLabel} />
        </EmptyState>
      }
    />
  );
}

/**
 * The agent's schedules: the working space's, or, in « Tous les espaces », every space's the reader
 * reaches, each row naming its space and opening there.
 */
export function AgentSchedulesTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const { on: spanning } = useOverviewMode();
  const schedulesQuery = useSchedules(packageId, { spanning });
  const schedules = schedulesQuery.data;
  const list = useLocalListParams();
  const states = list.values("state", ["active", "disabled"] as const);
  const columns = useScheduleColumns({ showAgentName: false, spanning });
  const [newScheduleOpen, setNewScheduleOpen] = useState(false);
  // A schedule is created in one space: in « Tous les espaces », one of the agent's that the
  // reader picks; the page enters it with the agent already read there.
  const create = useAgentSpaceAction(packageId, "schedules:write", detail?.space_ids, {
    preferWorkingSpace: false,
  });
  const openNew = () => {
    create.enteredDetail();
    setNewScheduleOpen(true);
  };

  if (detail && schemaHasFileFields(detail.input?.schema)) {
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
        isLoading={!detail || schedulesQuery.isPending}
        isError={schedulesQuery.isError}
        empty={
          hasSchedules ? (
            <NoMatchState message={t("detail.schedulesTable.noMatch")} onReset={list.reset} />
          ) : (
            <EmptyState message={t("detail.emptySchedule")} icon={CalendarClock} compact>
              <EmptyStateAction
                action={{
                  label: t("schedule.titleNew"),
                  onSelect: () => create.run(openNew),
                  inSpaces: create.choose(t("common:spaceChoice.schedule"), openNew),
                  hidden: !create.offered,
                }}
              />
            </EmptyState>
          )
        }
      />
      {newScheduleOpen && (
        <NewScheduleModal initialAgentId={packageId} onClose={() => setNewScheduleOpen(false)} />
      )}
    </>
  );
}

/** The agent's memory: the working space's, or, in « Tous les espaces », every space's the reader reaches. */
export function AgentMemoryTab({ packageId }: { packageId: string }) {
  const requestedType = useConsumedSearchParam("agentMemory");
  const { on: spanning } = useOverviewMode();
  const initialTypes: Array<"pinned" | "archive"> =
    requestedType === "pinned" || requestedType === "archive" ? [requestedType] : [];
  return <MemoryPanel packageId={packageId} initialTypes={initialTypes} spanning={spanning} />;
}
