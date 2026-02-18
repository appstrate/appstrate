import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { FlowListItem, FlowDetail } from "@appstrate/shared-types";

export function useFlows() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["flows", orgId],
    queryFn: async () => {
      const data = await api<{ flows: FlowListItem[] }>("/flows");
      return data.flows;
    },
  });
}

export function useFlowDetail(flowId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["flow", orgId, flowId],
    queryFn: async () => {
      const data = await api<FlowDetail>(`/flows/${flowId}`);
      return data;
    },
    enabled: !!flowId,
  });
}
