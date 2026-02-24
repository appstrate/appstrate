import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentProfileId } from "./use-current-profile";
import type { Integration } from "@appstrate/shared-types";

export function useServices() {
  const orgId = useCurrentOrgId();
  const profileId = useCurrentProfileId();
  return useQuery({
    queryKey: ["services", orgId, profileId],
    queryFn: async () => {
      const qs = profileId ? `?profileId=${profileId}` : "";
      const data = await apiFetch<{ integrations: Integration[] }>(`/auth/integrations${qs}`);
      return data.integrations;
    },
  });
}
