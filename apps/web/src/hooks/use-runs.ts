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

export function useAllRuns(page: number, limit = 20) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  const offset = page * limit;
  return useQuery({
    queryKey: ["all-runs", orgId, appId, page, limit],
    queryFn: async () => {
      return api<{ runs: Run[]; total: number }>(`/runs?limit=${limit}&offset=${offset}`);
    },
    enabled: !!orgId && !!appId,
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
