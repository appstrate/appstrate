// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { AvailableProvider } from "@appstrate/shared-types";

export function useAvailableProviders() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["available-providers", orgId, appId],
    queryFn: async () => {
      const data = await apiFetch<{ integrations: AvailableProvider[] }>(
        `/api/connections/integrations`,
      );
      return data.integrations;
    },
    enabled: !!orgId && !!appId,
  });
}
