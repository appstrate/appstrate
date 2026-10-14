// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { DataTable, type DataColumn } from "./data-table";
import { runDetailPath } from "../lib/package-paths";

export function RunsTable({
  runs,
  columns,
  agentName,
  isLoading,
  isError,
  error,
  empty,
  banner,
  columnMode,
  surface,
}: {
  runs: EnrichedRun[];
  /** From {@link useRunColumns}, minus whatever the reader hid. */
  columns: DataColumn<EnrichedRun>[];
  agentName: (run: EnrichedRun) => string;
  isLoading?: boolean;
  /** The request failed — which is not the same thing as an empty list. */
  isError?: boolean;
  /** Says WHY it failed. `DataTable` draws a default when no caller does. */
  error?: ReactNode;
  /** What an empty list says; `RunList` resolves the default. */
  empty: ReactNode;
  /** Pinned above the first row (e.g. a scheduled next run). */
  banner?: ReactNode;
  /** Level-one collections keep every reader-selected column reachable. */
  columnMode?: "tiered" | "scroll";
  surface?: "framed" | "integrated";
}) {
  const { t } = useTranslation(["agents"]);

  return (
    <DataTable
      tableId="runs"
      label={t("runs.tableLabel")}
      columns={columns}
      rows={runs}
      isLoading={isLoading}
      // A failed request is NOT an empty list: a 500 on `GET /api/runs` must
      // not read as "Aucun run". The two travel as separate props, so no caller
      // can fold one into the other.
      isError={isError}
      error={error}
      empty={empty}
      banner={banner}
      columnMode={columnMode}
      surface={surface}
      rowKey={(run) => run.id}
      // A deleted agent has no agent page, so `/agents/:packageId/runs/:id`
      // would 404: that row stays static rather than leading nowhere.
      rowHref={(run) => (run.packageId == null ? undefined : runDetailPath(run.packageId, run.id))}
      rowLabel={(run) =>
        t("runs.rowLabel", { number: run.runNumber ?? "?", agent: agentName(run) })
      }
      rowState={(run) => ({ runNumber: run.runNumber })}
    />
  );
}
