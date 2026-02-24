import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentProfileId } from "./use-current-profile";
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
  const profileId = useCurrentProfileId();
  return useQuery({
    queryKey: ["flow", orgId, flowId, profileId],
    queryFn: async () => {
      const qs = profileId ? `?profileId=${profileId}` : "";
      const data = await api<FlowDetail>(`/flows/${flowId}${qs}`);
      return data;
    },
    enabled: !!flowId,
  });
}
