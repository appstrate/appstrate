// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { ProviderConfig } from "@appstrate/shared-types";

interface ProvidersWireResponse {
  object: "list";
  data: ProviderConfig[];
  hasMore: boolean;
  callbackUrl?: string;
}

interface ProvidersResponse {
  providers: ProviderConfig[];
  callbackUrl?: string;
}

export function useProviders() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery<ProvidersResponse>({
    queryKey: ["providers", orgId, appId],
    queryFn: async () => {
      const env = await api<ProvidersWireResponse>("/providers");
      return { providers: env.data, callbackUrl: env.callbackUrl };
    },
    enabled: !!orgId && !!appId,
  });
}
