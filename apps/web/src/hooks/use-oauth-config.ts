// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";

export interface OAuthConfig {
  enabled: boolean;
  clientId?: string;
  allowSignup?: boolean;
  redirectUris?: string[];
}

interface OAuthCreatedResponse {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  enabled: boolean;
}

export function useOAuthConfig(appId: string) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["oauth-config", orgId, appId],
    queryFn: () => api<OAuthConfig>(`/applications/${appId}/oauth`),
    enabled: !!orgId && !!appId,
  });
}

export function useEnableOAuth() {
  return useMutation({
    mutationFn: async ({
      appId,
      redirectUris,
      allowSignup,
    }: {
      appId: string;
      redirectUris: string[];
      allowSignup?: boolean;
    }) => {
      return api<OAuthCreatedResponse>(`/applications/${appId}/oauth`, {
        method: "POST",
        body: JSON.stringify({ redirectUris, allowSignup }),
      });
    },
    // NOTE: Do NOT invalidate queries here — the modal must stay mounted to show
    // the one-time clientSecret. Queries are invalidated when the modal closes.
  });
}

/** Invalidate OAuth config queries — call after the secret modal is closed. */
export function useInvalidateOAuthConfig() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["oauth-config"] });
    qc.invalidateQueries({ queryKey: ["applications"] });
  };
}

export function useUpdateOAuth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      appId,
      data,
    }: {
      appId: string;
      data: { redirectUris?: string[]; allowSignup?: boolean };
    }) => {
      return api<{ updated: boolean }>(`/applications/${appId}/oauth`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oauth-config"] });
    },
  });
}

export function useDisableOAuth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (appId: string) => {
      return api<{ enabled: false }>(`/applications/${appId}/oauth`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oauth-config"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}
