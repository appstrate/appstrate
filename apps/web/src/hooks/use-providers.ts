// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { ProviderConfig } from "@appstrate/shared-types";

interface ProvidersResponse {
  providers: ProviderConfig[];
  callbackUrl?: string;
}

export function useProviders() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["providers", orgId],
    queryFn: () => api<ProvidersResponse>("/providers"),
    enabled: !!orgId,
  });
}
