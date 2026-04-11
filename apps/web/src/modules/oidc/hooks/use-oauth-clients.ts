// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the OIDC module's OAuth client admin API.
 * Mirrors the backend `/api/oauth/clients*` routes shipped in Stage 4.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentApplicationId } from "@/hooks/use-current-application";

export interface OAuthClient {
  id: string;
  clientId: string;
  name: string | null;
  applicationId: string;
  redirectUris: string[];
  scopes: string[];
  disabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface OAuthClientWithSecret extends OAuthClient {
  clientSecret: string;
}

export function useOAuthClients() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["oauth-clients", orgId, appId],
    queryFn: () =>
      api<{ object: "list"; data: OAuthClient[] }>("/oauth/clients").then((d) => d.data),
    enabled: !!orgId && !!appId,
  });
}

/**
 * Canonical scope vocabulary served by `GET /api/oauth/scopes`. Used by
 * the create-client modal checkbox group so the frontend never hardcodes
 * scope strings.
 */
export function useOAuthScopes() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["oauth-scopes", orgId, appId],
    queryFn: () => api<{ data: string[] }>("/oauth/scopes").then((d) => d.data),
    enabled: !!orgId && !!appId,
    staleTime: Infinity, // scope list is static within a deploy
  });
}

export function useCreateOAuthClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; redirectUris: string[]; scopes?: string[] }) =>
      api<OAuthClientWithSecret>("/oauth/clients", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
}

export function useUpdateOAuthClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      clientId,
      data,
    }: {
      clientId: string;
      data: { redirectUris?: string[]; disabled?: boolean };
    }) =>
      api<OAuthClient>(`/oauth/clients/${clientId}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
}

export function useDeleteOAuthClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) => api(`/oauth/clients/${clientId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
}

export function useRotateOAuthClientSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) =>
      api<OAuthClientWithSecret>(`/oauth/clients/${clientId}/rotate`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
}
