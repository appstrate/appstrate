// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { ProviderConfig } from "@appstrate/shared-types";

interface ProvidersResponse {
  providers: ProviderConfig[];
  callbackUrl?: string;
}

export function useProviders() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["providers", orgId, appId],
    queryFn: () => api<ProvidersResponse>("/providers"),
    enabled: !!orgId && !!appId,
  });
}

export interface AppProviderOverride {
  providerId: string;
  hasAppCredentials: boolean;
  appEnabled: boolean;
}

export function useAppProviderOverrides(appId: string | null) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["app-provider-overrides", orgId, appId],
    queryFn: () => api<{ data: AppProviderOverride[] }>(`/applications/${appId}/providers`),
    enabled: !!orgId && !!appId,
  });
}
