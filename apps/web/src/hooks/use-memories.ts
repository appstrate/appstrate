// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { AgentMemoryItem } from "@appstrate/shared-types";

export function useAgentMemories(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["agent-memories", orgId, packageId],
    queryFn: async () => {
      const res = await api<{ memories: AgentMemoryItem[] }>(`/agents/${packageId}/memories`);
      return res.memories;
    },
    enabled: !!packageId,
  });
}
