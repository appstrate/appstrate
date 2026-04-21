// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for per-application SMTP + social auth configuration.
 * Mirrors `/api/applications/:id/smtp-config` and
 * `/api/applications/:id/social-providers/:provider` routes.
 *
 * Inputs are Zod-validated client-side before hitting the API so the form
 * gets immediate feedback on obvious errors (bad port range, malformed
 * email). The server still validates — this is purely UX.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { SmtpConfigView, SocialProviderId, SocialProviderView } from "@appstrate/shared-types";
import { api, ApiError } from "@/api";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentApplicationId } from "@/hooks/use-current-application";

export type { SmtpConfigView, SocialProviderId, SocialProviderView };

export const upsertSmtpSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1, "Username is required"),
  pass: z.string().min(1, "Password is required"),
  fromAddress: z.email("Invalid email address"),
  fromName: z.string().nullable().optional(),
  secureMode: z.enum(["auto", "tls", "starttls", "none"]).optional(),
});

export type UpsertSmtpInput = z.infer<typeof upsertSmtpSchema>;

export const upsertSocialSchema = z.object({
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client secret is required"),
  scopes: z.array(z.string()).nullable().optional(),
});

export type UpsertSocialInput = z.infer<typeof upsertSocialSchema>;

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
    mutationFn: (data: UpsertSmtpInput) => {
      const parsed = upsertSmtpSchema.parse(data);
      return api<SmtpConfigView>(`/applications/${appId}/smtp-config`, {
        method: "PUT",
        body: JSON.stringify(parsed),
      });
    },
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
  const toSchema = z.email("Invalid email address");
  return useMutation({
    mutationFn: (to: string) => {
      const parsed = toSchema.parse(to);
      return api<{ ok: boolean; messageId?: string; error?: string }>(
        `/applications/${appId}/smtp-config/test`,
        { method: "POST", body: JSON.stringify({ to: parsed }) },
      );
    },
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
    mutationFn: (data: UpsertSocialInput) => {
      const parsed = upsertSocialSchema.parse(data);
      return api<SocialProviderView>(`/applications/${appId}/social-providers/${provider}`, {
        method: "PUT",
        body: JSON.stringify(parsed),
      });
    },
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
