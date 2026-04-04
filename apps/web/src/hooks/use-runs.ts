// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { Run, RunLog } from "@appstrate/shared-types";

export function useRuns(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["runs", orgId, appId, packageId],
    queryFn: async () => {
      const result = await api<{ runs: Run[]; total: number }>(`/agents/${packageId}/runs`);
      return result.runs;
    },
    enabled: !!packageId && !!appId,
  });
}

export function useRun(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["run", orgId, appId, runId],
    queryFn: async () => {
      return api<Run>(`/runs/${runId}`);
    },
    enabled: !!runId && !!appId,
  });
}

export function useRunLogs(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["run-logs", orgId, appId, runId],
    queryFn: async () => {
      return api<RunLog[]>(`/runs/${runId}/logs`);
    },
    enabled: !!runId && !!appId,
  });
}
