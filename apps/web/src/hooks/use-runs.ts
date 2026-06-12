// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api, apiList, buildQs, type ListEnvelope } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { EnrichedRun, RunLog } from "@appstrate/shared-types";

export function useRuns(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["runs", orgId, applicationId, packageId],
    queryFn: () => apiList<EnrichedRun>(`/agents/${packageId}/runs`),
    enabled: !!packageId && !!applicationId,
  });
}

export function useRun(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["run", orgId, applicationId, runId],
    queryFn: async () => {
      return api<EnrichedRun>(`/runs/${runId}`);
    },
    enabled: !!runId && !!applicationId,
  });
}

export function useRunLogs(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["run-logs", orgId, applicationId, runId],
    // The endpoint pages at 1000 rows (ASC by id) and signals continuation
    // via the envelope's `hasMore` + a `since=<lastId>` cursor. Page through
    // until exhausted so runs longer than one page keep their tail (final
    // output) visible. Hard cap at 20 pages (~20k rows) as a safety valve
    // against pathological runs.
    queryFn: async () => {
      const logs: RunLog[] = [];
      let since: number | undefined;
      for (let page = 0; page < 20; page++) {
        const envelope = await api<ListEnvelope<RunLog>>(
          `/runs/${runId}/logs${buildQs({ since })}`,
        );
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
