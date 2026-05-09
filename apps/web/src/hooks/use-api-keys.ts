// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { ApiKeyInfo } from "@appstrate/shared-types";

export function useApiKeys() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["api-keys", orgId, applicationId],
    queryFn: () => api<{ apiKeys: ApiKeyInfo[] }>("/api-keys").then((d) => d.apiKeys),
    enabled: !!orgId && !!applicationId,
  });
}

export function useAvailableScopes() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["api-keys/available-scopes", orgId],
    queryFn: () => api<{ scopes: string[] }>("/api-keys/available-scopes").then((d) => d.scopes),
    enabled: !!orgId,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; expiresAt: string | null; scopes?: string[] }) => {
      return api<{ id: string; key: string; keyPrefix: string; scopes: string[] }>("/api-keys", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/api-keys/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}
