// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api, apiList } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { Run, RunLog } from "@appstrate/shared-types";

export function useRuns(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["runs", orgId, applicationId, packageId],
    queryFn: () => apiList<Run>(`/agents/${packageId}/runs`),
    enabled: !!packageId && !!applicationId,
  });
}

export function useRun(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["run", orgId, applicationId, runId],
    queryFn: async () => {
      return api<Run>(`/runs/${runId}`);
    },
    enabled: !!runId && !!applicationId,
  });
}

export function useRunLogs(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["run-logs", orgId, applicationId, runId],
    queryFn: async () => {
      return api<RunLog[]>(`/runs/${runId}/logs`);
    },
    enabled: !!runId && !!applicationId,
  });
}
