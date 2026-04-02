// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { Execution, ExecutionLog } from "@appstrate/shared-types";

export function useExecutions(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["executions", orgId, packageId],
    queryFn: async () => {
      const result = await api<{ executions: Execution[]; total: number }>(
        `/flows/${packageId}/executions`,
      );
      return result.executions;
    },
    enabled: !!packageId,
  });
}

export function useExecution(execId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["execution", orgId, execId],
    queryFn: async () => {
      return api<Execution>(`/executions/${execId}`);
    },
    enabled: !!execId,
  });
}

export function useExecutionLogs(execId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["execution-logs", orgId, execId],
    queryFn: async () => {
      return api<ExecutionLog[]>(`/executions/${execId}/logs`);
    },
    enabled: !!execId,
  });
}
