import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";

export function useProfiles(userIds: string[]) {
  const orgId = useCurrentOrgId();
  const dedupedIds = useMemo(() => [...new Set(userIds.filter(Boolean))], [userIds]);

  const { data } = useQuery({
    queryKey: ["profiles", orgId, dedupedIds],
    queryFn: async () => {
      const result = await api<{
        profiles: { id: string; display_name: string }[];
      }>("/profiles/batch", {
        method: "POST",
        body: JSON.stringify({ ids: dedupedIds }),
      });
      return result.profiles;
    },
    enabled: dedupedIds.length > 0,
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    if (data) {
      for (const row of data) {
        if (row.display_name) map.set(row.id, row.display_name);
      }
    }
    return map;
  }, [data]);
}
