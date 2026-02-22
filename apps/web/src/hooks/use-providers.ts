import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { ProviderConfig } from "@appstrate/shared-types";

export function useProviders() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["providers", orgId],
    queryFn: () => api<{ providers: ProviderConfig[] }>("/providers").then((d) => d.providers),
    enabled: !!orgId,
  });
}
