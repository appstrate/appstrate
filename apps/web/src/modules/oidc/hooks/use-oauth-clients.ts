// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the OIDC module's OAuth client admin API.
 * Mirrors the backend `/api/oauth/clients*` routes shipped in Stage 4.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentApplicationId } from "@/hooks/use-current-application";
import type {
  OAuthClientRecord as OAuthClient,
  OAuthClientWithSecret,
} from "../../../../../api/src/modules/oidc/services/oauth-admin.ts";

export type { OAuthClient, OAuthClientWithSecret };

export function useOAuthClients(level?: "org" | "application") {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  const isOrg = level === "org";
  return useQuery({
    queryKey: ["oauth-clients", orgId, isOrg ? "org" : appId],
    queryFn: () =>
      api<{ object: "list"; data: OAuthClient[] }>("/oauth/clients").then((d) =>
        level ? d.data.filter((c) => c.level === level) : d.data,
      ),
    enabled: isOrg ? !!orgId : !!orgId && !!appId,
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

export function useCreateOAuthClient(level?: "org" | "application") {
  const qc = useQueryClient();
  const appId = useCurrentApplicationId();
  const orgId = useCurrentOrgId();
  const isOrg = level === "org";
  return useMutation({
    mutationFn: async (data: {
      name: string;
      redirectUris: string[];
      postLogoutRedirectUris?: string[];
      scopes?: string[];
      isFirstParty?: boolean;
    }) =>
      api<OAuthClientWithSecret>("/oauth/clients", {
        method: "POST",
        body: JSON.stringify(
          isOrg
            ? { level: "org", referencedOrgId: orgId, ...data }
            : { level: "application", referencedApplicationId: appId, ...data },
        ),
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
      data: {
        redirectUris?: string[];
        postLogoutRedirectUris?: string[];
        disabled?: boolean;
        isFirstParty?: boolean;
      };
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
