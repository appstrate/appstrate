// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Calendar } from "lucide-react";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import { DataTable, type DataColumn } from "./data-table";
import { EmptyState } from "./page-states";
import { scheduleDetailPath } from "../lib/package-paths";
import { linkedSpacePath } from "../lib/across-spaces";
import { useCurrentSpaceId } from "../hooks/use-current-space";

export function SchedulesTable({
  schedules,
  columns,
  isLoading,
  isError,
  error,
  empty,
  surface,
}: {
  schedules: EnrichedSchedule[];
  /** From {@link useScheduleColumns}, minus whatever the reader hid. */
  columns: DataColumn<EnrichedSchedule>[];
  isLoading?: boolean;
  isError?: boolean;
  /** The failure, said the way the caller words it; the table has a default. */
  error?: React.ReactNode;
  empty?: React.ReactNode;
  /** Embedded lists share their parent white surface and do not draw a second frame. */
  surface?: "framed" | "integrated";
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const currentSpaceId = useCurrentSpaceId();

  return (
    <DataTable
      tableId="schedules"
      label={t("schedules.tableLabel")}
      columns={columns}
      surface={surface}
      rows={schedules}
      isLoading={isLoading}
      isError={isError}
      error={error}
      empty={empty ?? <EmptyState message={t("schedules.empty")} icon={Calendar} compact />}
      rowKey={(schedule) => schedule.id}
      // A schedule of another space (a list spanning several) names it: the detail enters it.
      rowHref={(schedule) =>
        linkedSpacePath(scheduleDetailPath(schedule.id), schedule.spaceId, currentSpaceId)
      }
      rowLabel={(schedule) => schedule.name || t("schedule.unnamed", { ns: "agents" })}
    />
  );
}
