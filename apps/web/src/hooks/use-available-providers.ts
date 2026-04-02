// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { AvailableProvider } from "@appstrate/shared-types";

export function useAvailableProviders() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["available-providers", orgId],
    queryFn: async () => {
      const data = await apiFetch<{ integrations: AvailableProvider[] }>(
        `/api/connections/integrations`,
      );
      return data.integrations;
    },
  });
}
