// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for per-application SMTP + social auth configuration.
 * Mirrors `/api/applications/:id/smtp-config` and
 * `/api/applications/:id/social-providers/:provider` routes.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/api";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentApplicationId } from "@/hooks/use-current-application";

export type SocialProviderId = "google" | "github";

export interface SmtpConfigView {
  applicationId: string;
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  fromName: string | null;
  secureMode: "auto" | "tls" | "starttls" | "none";
  createdAt: string;
  updatedAt: string;
}

export interface SocialProviderView {
  applicationId: string;
  provider: SocialProviderId;
  clientId: string;
  scopes: string[] | null;
  createdAt: string;
  updatedAt: string;
}

async function getOrNull<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function useSmtpConfig() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["smtp-config", orgId, appId],
    queryFn: () => getOrNull<SmtpConfigView>(`/applications/${appId}/smtp-config`),
    enabled: !!orgId && !!appId,
  });
}

export function useUpsertSmtpConfig() {
  const qc = useQueryClient();
  const appId = useCurrentApplicationId();
  return useMutation({
    mutationFn: (data: {
      host: string;
      port: number;
      username: string;
      pass: string;
      fromAddress: string;
      fromName?: string | null;
      secureMode?: "auto" | "tls" | "starttls" | "none";
    }) =>
      api<SmtpConfigView>(`/applications/${appId}/smtp-config`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["smtp-config"] });
    },
  });
}

export function useDeleteSmtpConfig() {
  const qc = useQueryClient();
  const appId = useCurrentApplicationId();
  return useMutation({
    mutationFn: () => api(`/applications/${appId}/smtp-config`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["smtp-config"] });
    },
  });
}

export function useTestSmtp() {
  const appId = useCurrentApplicationId();
  return useMutation({
    mutationFn: (to: string) =>
      api<{ ok: boolean; messageId?: string; error?: string }>(
        `/applications/${appId}/smtp-config/test`,
        { method: "POST", body: JSON.stringify({ to }) },
      ),
  });
}

export function useSocialProvider(provider: SocialProviderId) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["social-provider", orgId, appId, provider],
    queryFn: () =>
      getOrNull<SocialProviderView>(`/applications/${appId}/social-providers/${provider}`),
    enabled: !!orgId && !!appId,
  });
}

export function useUpsertSocialProvider(provider: SocialProviderId) {
  const qc = useQueryClient();
  const appId = useCurrentApplicationId();
  return useMutation({
    mutationFn: (data: { clientId: string; clientSecret: string; scopes?: string[] | null }) =>
      api<SocialProviderView>(`/applications/${appId}/social-providers/${provider}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social-provider"] });
    },
  });
}

export function useDeleteSocialProvider(provider: SocialProviderId) {
  const qc = useQueryClient();
  const appId = useCurrentApplicationId();
  return useMutation({
    mutationFn: () =>
      api(`/applications/${appId}/social-providers/${provider}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social-provider"] });
    },
  });
}
