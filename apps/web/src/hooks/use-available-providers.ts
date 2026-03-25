import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentProfileId } from "./use-current-profile";
import type { AvailableProvider } from "@appstrate/shared-types";

export function useAvailableProviders() {
  const orgId = useCurrentOrgId();
  const profileId = useCurrentProfileId();
  return useQuery({
    queryKey: ["available-providers", orgId, profileId],
    queryFn: async () => {
      const qs = profileId ? `?profileId=${profileId}` : "";
      const data = await apiFetch<{ integrations: AvailableProvider[] }>(
        `/api/connections/integrations${qs}`,
      );
      return data.integrations;
    },
  });
}
