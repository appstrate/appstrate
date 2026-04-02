// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { FlowMemoryItem } from "@appstrate/shared-types";

export function useFlowMemories(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["flow-memories", orgId, packageId],
    queryFn: async () => {
      const res = await api<{ memories: FlowMemoryItem[] }>(`/flows/${packageId}/memories`);
      return res.memories;
    },
    enabled: !!packageId,
  });
}
