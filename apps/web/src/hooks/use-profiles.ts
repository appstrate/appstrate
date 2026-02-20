import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "../lib/supabase";
import { useCurrentOrgId } from "./use-org";

export function useProfiles(userIds: string[]) {
  const orgId = useCurrentOrgId();
  const dedupedIds = useMemo(() => [...new Set(userIds.filter(Boolean))], [userIds]);

  const { data } = useQuery({
    queryKey: ["profiles", orgId, dedupedIds],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", dedupedIds);
      if (error) throw new Error(error.message);
      return data;
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
