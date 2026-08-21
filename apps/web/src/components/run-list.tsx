// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PlayCircle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { usePaginatedRuns, type RunKindFilter } from "../hooks/use-paginated-runs";
import { useAgents } from "../hooks/use-packages";
import { RunsTable } from "./runs-table";
import { EmptyState, ErrorState } from "./page-states";
import type { EnrichedRun } from "@appstrate/shared-types";
import { inlineRunDisplayName } from "../lib/run-title";

interface RunListProps {
  packageId?: string;
  scheduleId?: string;
  /** Fixed agent name -- skips agent lookup when set (e.g. schedule detail) */
  fixedAgentName?: string;
  /** Items per page (default 20) */
  pageSize?: number;
  /** Show pagination controls (default true) */
  paginated?: boolean;
  /** Hide agent name column (when already in agent context) */
  hideAgentName?: boolean;
  /** Custom empty state (replaces default) */
  emptyState?: React.ReactNode;
  /** Preview row shown above the first page (e.g. scheduled next-run) */
  firstPageBanner?: React.ReactNode;
  /** Filter runs by user -- "me" for current user only */
  user?: "me";
  /** Filter runs by kind -- "all" | "package" | "inline" */
  kind?: RunKindFilter;
}

interface RunRowsProps {
  /** Runs to render, already fetched by the caller. */
  runs: EnrichedRun[];
  /** Still loading — renders the loading placeholder instead of the rows. */
  isLoading?: boolean;
  /** The request failed — see {@link RunRows} on why this is not the empty state. */
  isError?: boolean;
  fixedAgentName?: string;
  hideAgentName?: boolean;
  emptyState?: React.ReactNode;
  /** Row pinned above the list (e.g. scheduled next-run preview). */
  banner?: React.ReactNode;
}

/**
 * The presentation half of {@link RunList}: rows, agent-name resolution, empty
 * and loading states — no fetching of its own.
 *
 * Split out so a page that ALREADY has runs in hand can render them without a
 * second request. The dashboard is exactly that case: it loads 15 runs for its
 * own header, and mounting `<RunList pageSize={7}>` underneath issued a second
 * `GET /api/runs` (a different `limit` = a different React Query key = a
 * different network call, each one a `COUNT` plus an enriched page read).
 *
 * `useAgents()` here is not an extra request: it is the same query key every
 * caller of this component already holds, served from cache.
 */
export function RunRows({
  runs,
  isLoading = false,
  isError = false,
  fixedAgentName,
  hideAgentName = false,
  emptyState,
  banner,
}: RunRowsProps) {
  const { t } = useTranslation(["agents"]);
  const { data: agents } = useAgents();

  const agentNameMap = new Map<string, string>();
  if (!hideAgentName && !fixedAgentName && agents) {
    for (const f of agents) {
      agentNameMap.set(f.id, f.display_name ?? f.id);
    }
  }

  const resolveAgentName = (run: EnrichedRun) => {
    if (hideAgentName) return undefined;
    if (fixedAgentName) return fixedAgentName;
    // Inline runs: use the manifest displayName snapshot (run.agent_name) — the
    // raw shadow packageId (`@inline/r-…`) is never meaningful to users, and
    // the ephemeral row isn't in `agents` so the map lookup would miss anyway.
    if (run.package_ephemeral === true) {
      return inlineRunDisplayName(run.agent_name, t("runs.inlineBadge"));
    }
    // Source agent deleted (FK SET NULL): fall back to the denormalized
    // `agent_name` snapshot stamped at INSERT time, then to a generic label.
    if (run.packageId == null) {
      return run.agent_name ?? t("runs.deletedAgent", { ns: "agents" });
    }
    return agentNameMap.get(run.packageId) ?? run.agent_name ?? run.packageId;
  };

  // A failed request is NOT an empty list. The lab's `error` scenario is what
  // showed it: with `GET /api/runs` answering 500, the page said "Aucun run" —
  // telling a user their history is empty when the truth is that it could not
  // be read.
  const fallback = isError ? (
    <ErrorState />
  ) : (
    (emptyState ?? <EmptyState message={t("detail.emptyRuns")} icon={PlayCircle} compact />)
  );

  return (
    <RunsTable
      runs={runs}
      hideAgentName={hideAgentName}
      agentName={resolveAgentName}
      isLoading={isLoading}
      banner={banner}
      empty={fallback}
    />
  );
}

export function RunList({
  packageId,
  scheduleId,
  fixedAgentName,
  pageSize = 20,
  paginated = true,
  hideAgentName = false,
  emptyState,
  firstPageBanner,
  user,
  kind,
}: RunListProps) {
  const { t } = useTranslation(["agents"]);
  const [page, setPage] = useState(0);

  const { data, isLoading, isError } = usePaginatedRuns({
    packageId,
    scheduleId,
    user,
    kind,
    limit: pageSize,
    offset: page * pageSize,
  });

  const runs: EnrichedRun[] = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  // Only the first page shows a placeholder; paging keeps the previous rows.
  const showLoading = isLoading && page === 0;

  if (showLoading || runs.length === 0) {
    return (
      <RunRows
        runs={runs}
        isLoading={showLoading}
        isError={isError}
        fixedAgentName={fixedAgentName}
        hideAgentName={hideAgentName}
        emptyState={emptyState}
      />
    );
  }

  return (
    <div className="space-y-2">
      <RunRows
        runs={runs}
        fixedAgentName={fixedAgentName}
        hideAgentName={hideAgentName}
        emptyState={emptyState}
        banner={page === 0 ? firstPageBanner : undefined}
      />

      {paginated && totalPages > 1 && (
        <div className="flex items-center justify-end gap-4 pt-1">
          <span className="text-muted-foreground text-sm">
            {t("pagination.pageOf", {
              page: page + 1,
              total: totalPages,
              ns: "common",
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p - 1)}
              disabled={page === 0}
            >
              {t("pagination.previous", { ns: "common" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages - 1}
            >
              {t("pagination.next", { ns: "common" })}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
