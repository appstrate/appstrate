import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { FlowListItem, FlowDetail } from "@openflows/shared-types";

export function useFlows() {
  return useQuery({
    queryKey: ["flows"],
    queryFn: async () => {
      const data = await api<{ flows: FlowListItem[] }>("/flows");
      return data.flows;
    },
  });
}

export function useFlowDetail(flowId: string | undefined) {
  return useQuery({
    queryKey: ["flow", flowId],
    queryFn: async () => {
      const data = await api<FlowDetail>(`/flows/${flowId}`);
      return data;
    },
    enabled: !!flowId,
  });
}
