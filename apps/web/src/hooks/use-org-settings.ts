// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrgSettings } from "@appstrate/shared-types";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";

export type { OrgSettings };

export function useOrgSettings() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () => api<OrgSettings>(`/orgs/${orgId}/settings`),
    enabled: !!orgId,
  });
}

export function useUpdateOrgSettings() {
  const queryClient = useQueryClient();
  const orgId = useCurrentOrgId();
  return useMutation({
    mutationFn: (updates: Partial<OrgSettings>) =>
      api<OrgSettings>(`/orgs/${orgId}/settings`, {
        method: "PUT",
        body: JSON.stringify(updates),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["org-settings", orgId], data);
    },
  });
}
