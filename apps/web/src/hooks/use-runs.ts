// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { Run, RunLog } from "@appstrate/shared-types";

export function useRuns(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["runs", orgId, packageId],
    queryFn: async () => {
      const result = await api<{ runs: Run[]; total: number }>(`/agents/${packageId}/runs`);
      return result.runs;
    },
    enabled: !!packageId,
  });
}

export function useRun(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["run", orgId, runId],
    queryFn: async () => {
      return api<Run>(`/runs/${runId}`);
    },
    enabled: !!runId,
  });
}

export function useRunLogs(runId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["run-logs", orgId, runId],
    queryFn: async () => {
      return api<RunLog[]>(`/runs/${runId}/logs`);
    },
    enabled: !!runId,
  });
}
