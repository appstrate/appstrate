// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { AvailableProvider } from "@appstrate/shared-types";

export function useAvailableProviders(connectionProfileId?: string | null) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const qs = connectionProfileId ? `?connectionProfileId=${connectionProfileId}` : "";
  return useQuery({
    queryKey: ["available-providers", orgId, applicationId, connectionProfileId ?? null],
    queryFn: async () => {
      const data = await apiFetch<{ integrations: AvailableProvider[] }>(
        `/api/connections/integrations${qs}`,
      );
      return data.integrations;
    },
    enabled: !!orgId && !!applicationId,
  });
}
