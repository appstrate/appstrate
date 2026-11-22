// SPDX-License-Identifier: Apache-2.0

/**
 * A page of runs: the query, the paging, and the table underneath.
 *
 * Agent names resolve in `use-run-agent-name.ts` and their tiles in
 * `use-run-agent-identity.ts`; the table draws the rows.
 * What is left here is fetching.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useRuns, type RunKindFilter } from "../hooks/use-paginated-runs";
import { useRunAgentName } from "../hooks/use-run-agent-name";
import { useRunAgentIdentity } from "../hooks/use-run-agent-identity";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { RunsTable } from "./runs-table";
import { useRunColumns } from "./run-columns";
import { EmptyState, ErrorState } from "./page-states";
import { useColumnVisibility } from "../stores/column-visibility-store";
import type { EnrichedRun } from "@appstrate/shared-types";
import type { RunStatus } from "@appstrate/core/run-status";
import type { SpaceKind } from "../lib/space-filter";
import { KeysetListFooter, type ColumnMenuSpec } from "./list-toolbar";
import { PlayCircle } from "lucide-react";

interface RunListProps {
  packageId?: string;
  scheduleId?: string;
  /** Fixed agent name -- skips agent lookup when set (e.g. schedule detail) */
  fixedAgentName?: string;
  /** Custom empty state (replaces default) */
  emptyState?: React.ReactNode;
  /** Preview row shown above the first page (e.g. scheduled next-run) */
  banner?: React.ReactNode;
  /** Filter runs by user -- "me" for current user only */
  user?: "me";
  /** Filter runs by kind -- "all" | "package" | "inline" */
  kind?: RunKindFilter;
  /** Filter runs by lifecycle status — one, or several at once. */
  status?: RunStatus[];
  /** Free text: the agent a run executed, the error it ended on, its number. */
  search?: string;
  /** Every space the reader reaches instead of the current one; each row then names its space. */
  spanning?: boolean;
  /** With `spanning`: only team or personal spaces' runs (the runs page's space filter). */
  spaceKind?: SpaceKind;
  /**
   * The bar above the table.
   *
   * A render prop rather than props the page reads for itself: the columns live
   * here, and the bar's column menu has to name the same ones the table draws.
   * The page still owns WHAT the bar says. `empty`: the list answered with no run, so what sits
   * beside the empty state (a notice) can give way to it.
   */
  toolbar?: (bar: { columns: ColumnMenuSpec; empty: boolean }) => React.ReactNode;
}

export function RunList({
  packageId,
  scheduleId,
  fixedAgentName,
  emptyState,
  banner,
  user,
  kind,
  status,
  search,
  spanning = false,
  spaceKind,
  toolbar,
}: RunListProps) {
  const { t } = useTranslation(["agents"]);
  // Inside one agent (its tab, a schedule's history) the « Run » column leads
  // with the number: the agent is the page's title.
  const oneAgent = packageId != null || scheduleId != null;
  // One agent's runs name no agent from the org's index: the working space's serves.
  const agentName = useRunAgentName({ fixed: fixedAgentName, spanning: spanning && !oneAgent });
  const agentIdentity = useRunAgentIdentity(spanning && !oneAgent);
  const allColumns = useRunColumns({
    agentName,
    agentIdentity,
    oneAgent,
    spanning,
  });
  // Per TABLE, not per screen: the run list keeps its columns wherever it is
  // shown — the runs page, an agent's tab, a schedule's history.
  const { columns, menu } = useColumnVisibility("runs", allColumns);

  // The search asks once the typing pauses; clearing it asks at once.
  const debouncedSearch = useDebouncedValue(search ?? "");
  const querySearch = search ? debouncedSearch : "";

  const query = useRuns({
    packageId,
    scheduleId,
    user,
    kind,
    status,
    spanning,
    spaceKind,
    search: querySearch || undefined,
  });
  const { data, isLoading, isError, error } = query;

  const runs: EnrichedRun[] = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);
  // Undefined until the request answers: `?? 0` would tell the footer there were zero runs on a 500.
  const total = data?.pages[data.pages.length - 1]?.total;

  // A refused or failed listing is not "no runs": the body says the refusal.
  // Only when nothing was loaded: a failed background refetch keeps the rows.
  const failed = isError && !data;
  const errorBody = <ErrorState error={error} compact />;
  const emptyBody = emptyState ?? (
    <EmptyState message={t("detail.emptyRuns")} icon={PlayCircle} compact />
  );

  return (
    <div>
      {toolbar?.({ columns: menu, empty: !isLoading && !failed && runs.length === 0 })}

      <RunsTable
        runs={runs}
        columns={columns}
        agentName={agentName}
        isLoading={isLoading}
        isError={failed}
        error={errorBody}
        empty={emptyBody}
        banner={banner}
      />

      {/* Silent until the first page answers: a count on a loading or failed list would claim "0 run". */}
      <KeysetListFooter
        query={query}
        loaded={runs.length}
        total={total}
        ready={!isLoading && !failed}
      />
    </div>
  );
}
