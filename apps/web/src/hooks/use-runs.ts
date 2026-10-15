// SPDX-License-Identifier: Apache-2.0

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canReadRuns } from "@appstrate/core/permissions";
import { client, type components } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { usePermissions } from "./use-permissions";
import { paginatedRunsKeys, runKeys } from "../lib/query-keys";
import type { EnrichedRun, ListEnvelope } from "@appstrate/shared-types";

/** Wire shape of a persisted log row: `createdAt` is an ISO string, unlike shared-types `RunLog` (Date). */
type RunLogEntry = components["schemas"]["RunLog"];

/** Every run read below guards on `requireRunsRead`. */
function useCanReadRuns(): boolean {
  const { can } = usePermissions();
  return canReadRuns(can);
}

export function useRun(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const canRead = useCanReadRuns();
  const qc = useQueryClient();
  return useQuery({
    // Key pinned: use-global-run-sync and run-detail patch this cache in place on SSE events.
    queryKey: runKeys.detail(orgId, spaceId, runId),
    queryFn: async (): Promise<EnrichedRun> => {
      const { data } = await client.GET("/api/runs/{id}", {
        params: { path: { id: runId! } },
      });
      // Non-2xx throws via the client middleware, so `data` is defined here.
      return data!;
    },
    // A run list usually holds the row already: it names the run until the detail lands. Inline
    // runs are left out: their manifest and prompt ride only on the detail ("details expired").
    placeholderData: () => {
      if (!runId) return undefined;
      const pages = qc.getQueriesData<ListEnvelope<EnrichedRun>>({
        queryKey: [...paginatedRunsKeys.all, orgId, spaceId],
      });
      for (const [, page] of pages) {
        const row = page?.data?.find((candidate) => candidate.id === runId);
        if (row && !row.package_ephemeral) return row;
      }
      return undefined;
    },
    enabled: canRead && !!runId && !!spaceId,
  });
}

export function useRunLogs(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const canRead = useCanReadRuns();
  return useQuery({
    // Key pinned: run-detail appends live SSE log frames into this cache.
    queryKey: runKeys.logs(orgId, spaceId, runId),
    // Pages at 1000 rows via `hasMore` + `since=<lastId>`; walked to the end so the tail (final
    // output) stays visible. Capped at 20 pages (~20k rows) against pathological runs.
    queryFn: async () => {
      const logs: RunLogEntry[] = [];
      let since: number | undefined;
      for (let page = 0; page < 20; page++) {
        const { data: envelope } = await client.GET("/api/runs/{id}/logs", {
          params: { path: { id: runId! }, query: { since } },
        });
        if (!envelope) break;
        logs.push(...envelope.data);
        const last = envelope.data[envelope.data.length - 1];
        if (!envelope.hasMore || !last) break;
        since = last.id;
      }
      return logs;
    },
    enabled: canRead && !!runId && !!spaceId,
  });
}
