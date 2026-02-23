import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { Execution, ExecutionLog } from "@appstrate/shared-types";

export function useExecutions(flowId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["executions", orgId, flowId],
    queryFn: async () => {
      return api<Execution[]>(`/flows/${flowId}/executions`);
    },
    enabled: !!flowId,
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
