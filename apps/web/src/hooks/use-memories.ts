import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { FlowMemoryItem } from "@appstrate/shared-types";

export function useFlowMemories(flowId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["flow-memories", orgId, flowId],
    queryFn: async () => {
      const res = await api<{ memories: FlowMemoryItem[] }>(`/flows/${flowId}/memories`);
      return res.memories;
    },
    enabled: !!flowId,
  });
}
