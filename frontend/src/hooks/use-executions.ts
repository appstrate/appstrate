import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { Execution, ExecutionLog } from "../types";

export function useExecutions(flowId: string | undefined) {
  return useQuery({
    queryKey: ["executions", flowId],
    queryFn: async () => {
      const data = await api<{ executions: Execution[] }>(`/flows/${flowId}/executions?limit=50`);
      return data.executions;
    },
    enabled: !!flowId,
  });
}

export function useExecution(execId: string | undefined) {
  return useQuery({
    queryKey: ["execution", execId],
    queryFn: async () => {
      return api<Execution>(`/executions/${execId}`);
    },
    enabled: !!execId,
  });
}

export function useExecutionLogs(execId: string | undefined) {
  return useQuery({
    queryKey: ["execution-logs", execId],
    queryFn: async () => {
      const data = await api<{ logs: ExecutionLog[] }>(`/executions/${execId}/logs`);
      return data.logs;
    },
    enabled: !!execId,
  });
}
