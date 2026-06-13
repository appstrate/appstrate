// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { client, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { runsKeys, runKeys } from "../lib/query-keys";
import type { EnrichedRun } from "@appstrate/shared-types";

/**
 * Wire shape of a persisted log row (spec `RunLog`): on the wire `createdAt`
 * is an ISO string, unlike the Drizzle-derived shared-types `RunLog` (Date).
 */
type RunLogEntry = components["schemas"]["RunLog"];

export function useRuns(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key pinned to the legacy shape: use-global-run-sync patches this cache
    // in place (setQueryData) on SSE run_update events.
    queryKey: runsKeys.forAgent(orgId, applicationId, packageId),
    queryFn: async (): Promise<EnrichedRun[]> => {
      const { scope, name } = splitPackageRef(packageId!);
      const { data } = await client.GET("/api/agents/{scope}/{name}/runs", {
        params: { path: { scope, name } },
      });
      return data?.data ?? [];
    },
    enabled: !!packageId && !!applicationId,
  });
}

export function useRun(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key pinned to the legacy shape: use-global-run-sync and run-detail patch
    // this cache in place (setQueryData) on SSE events.
    queryKey: runKeys.detail(orgId, applicationId, runId),
    queryFn: async (): Promise<EnrichedRun> => {
      const { data } = await client.GET("/api/runs/{id}", {
        params: { path: { id: runId! } },
      });
      // Non-2xx throws via the client middleware, so `data` is defined here.
      return data!;
    },
    enabled: !!runId && !!applicationId,
  });
}

export function useRunLogs(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key pinned to the legacy shape: run-detail appends live SSE log frames
    // into this cache (setQueryData).
    queryKey: runKeys.logs(orgId, applicationId, runId),
    // The endpoint pages at 1000 rows (ASC by id) and signals continuation
    // via the envelope's `hasMore` + a `since=<lastId>` cursor. Page through
    // until exhausted so runs longer than one page keep their tail (final
    // output) visible. Hard cap at 20 pages (~20k rows) as a safety valve
    // against pathological runs.
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
    enabled: !!runId && !!applicationId,
  });
}
