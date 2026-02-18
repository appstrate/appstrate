import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { Integration } from "@appstrate/shared-types";

export function useServices() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["services", orgId],
    queryFn: async () => {
      const data = await apiFetch<{ integrations: Integration[] }>("/auth/integrations");
      return data.integrations;
    },
  });
}
