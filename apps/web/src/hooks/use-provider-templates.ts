import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { ProviderTemplate } from "@appstrate/shared-types";

interface ProviderTemplatesResponse {
  templates: ProviderTemplate[];
  callbackUrl: string;
}

export function useProviderTemplates(search = "") {
  const orgId = useCurrentOrgId();
  const trimmed = search.trim();
  return useQuery({
    queryKey: ["provider-templates", orgId, trimmed],
    queryFn: () =>
      api<ProviderTemplatesResponse>(
        `/provider-templates${trimmed ? `?search=${encodeURIComponent(trimmed)}` : ""}`,
      ),
    enabled: !!orgId,
    placeholderData: keepPreviousData,
  });
}
